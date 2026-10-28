// Closes a launch once its bidding window has passed: settles the auction
// from the Zcash wallet, posts the allocation root on Solana, pays refunds and
// receipts on Zcash, and prices the ZEC raised in SOL with a live NEAR quote.
// Safe to re-run: a posted root is checked rather than posted again, and paid
// bids are skipped.
//
//   node scripts/close-launch.ts <launch.json> [--no-payout]

import { Connection, PublicKey } from "@solana/web3.js";
import { join } from "node:path";
import { readReceived, readSent, scanBids } from "../../watcher/src/bids.ts";
import { chainTip, pay, refresh, shieldedBalance, viewingKey } from "../../watcher/src/devtool.ts";
import { batches, feeEstimateZats, planPayouts, withLateBids } from "../../watcher/src/payouts.ts";
import { payBatch } from "../../watcher/src/pay-batch.ts";
import { drandSignature, unseal } from "../../watcher/src/sealed.ts";
import { frostPayUri } from "../../watcher/src/frost.ts";
import { settle } from "../../watcher/src/settle.ts";
import { writeFileSync } from "node:fs";
import { closeWithoutSale, fetchLaunch, loadKeypair, program, setRoot, withdrawUnsold } from "../src/client.ts";
import { expandHome, readLaunch, writeJson } from "../src/launch-file.ts";
import { quoteZecToSol } from "../src/near.ts";

const [path, flag] = process.argv.slice(2);
const launch = readLaunch(path);
const { startHeight, endHeight, identity } = launch.zcash;
if (startHeight === undefined || endHeight === undefined || !launch.solana.launchId) throw new Error("launch is not open");

// Settle only once the window's last blocks are a few blocks deep, so a chain
// reorganisation cannot change which bids landed inside it.
const SETTLE_MARGIN = 3;
// Payouts per transaction. Shielded outputs cost no extra signatures, so FROST
// wallets batch like the others.
const PAYOUTS_PER_TX = 8;

const wallet = { bin: launch.zcash.devtool, dir: launch.zcash.walletDir, identity };
await refresh(wallet);
const tip = await chainTip(wallet);
if (tip < endHeight + SETTLE_MARGIN) {
  // An expected state, not a failure: say when to come back. Exit code 3 lets scripts wait and retry.
  console.log(`${launch.name}: not ready to settle: chain at ${tip}, window ends at ${endHeight}, settle from ${endHeight + SETTLE_MARGIN}`);
  process.exit(3);
}

const db = join(wallet.dir, "data.sqlite");
let received = readReceived(db);
if (launch.seal) {
  // Sealed bids open only with drand's signature for the launch's round.
  const signature = await drandSignature(launch.seal.round);
  if (signature === null) {
    console.log(`${launch.name}: not ready to settle: bids unseal at drand round ${launch.seal.round} (${new Date(launch.seal.revealAt * 1000).toISOString()})`);
    process.exit(3);
  }
  received = await unseal(received, launch.seal, signature);
}
const scan = scanBids(received, { startHeight, endHeight, ...(launch.seal && { sealedUntil: launch.seal.revealAt }), ...(launch.sale.deposit && { deposit: BigInt(launch.sale.deposit) }) });
const s = settle(scan.bids, { supply: BigInt(launch.sale.supply), decimals: launch.sale.decimals, reservePrice: BigInt(launch.sale.reservePrice) });
writeJson(path.replace(/\.json$/, ".settlement.json"), { ...s, rejected: scan.rejected });
console.log(`${launch.name}: ${scan.bids.length} bids, price ${s.price ? `${s.price.num}/${s.price.den}` : "none"}, ${s.tokensSold} sold, ${s.raisedZats} zats raised`);

const connection = new Connection(launch.solana.rpc, "confirmed");
const creator = loadKeypair(expandHome(launch.solana.keypair));
const p = program(connection, creator);
const launchId = BigInt(launch.solana.launchId);
const onChain = await fetchLaunch(p, creator.publicKey, launchId);
if (!onChain.finalized && s.root === null) {
  console.log(`  nothing sold: closed on Solana without a sale: ${await closeWithoutSale(p, creator.publicKey, launchId)}`);
} else if (!onChain.finalized && s.root !== null) {
  console.log(`  root ${s.root.slice(0, 16)}… posted on Solana: ${await setRoot(p, creator.publicKey, launchId, s.root, s.tokensSold)}`);
} else if (onChain.root !== s.root) {
  throw new Error(`Solana (${onChain.noSale ? "closed without sale" : onChain.root}) differs from this settlement (${s.root})`);
} else {
  console.log(`  already final on Solana and matches (${onChain.noSale ? "no sale" : "root"})`);
}
// The result is final on Solana, so publish the viewing key: anyone can now
// re-run the auction from the Zcash chain and check refunds (audit-launch.ts).
const keyPath = path.replace(/\.json$/, ".viewkey.txt");
writeFileSync(keyPath, `${await viewingKey(wallet)}\n`);
console.log(`  viewing key published: ${keyPath}`);

const unsold = BigInt(launch.sale.supply) - s.tokensSold;
const after = await fetchLaunch(p, creator.publicKey, launchId);
if (unsold > 0n && !after.unsoldWithdrawn) {
  const mint = new PublicKey(launch.solana.mint!);
  console.log(`  ${unsold} unsold tokens returned to the creator: ${await withdrawUnsold(p, creator.publicKey, mint, launchId)}`);
}

if (flag !== "--no-payout") {
  const plan = planPayouts(withLateBids(s.outcomes, scan.rejected), s.price, readSent(db), tip);
  // FROST or not, each transaction pays a batch of payouts, one output each.
  const frost = launch.custody?.kind === "frost" ? launch.custody : null;
  const groups = batches(plan.payouts, PAYOUTS_PER_TX);
  const need = plan.payouts.reduce((t, x) => t + x.zats, 0n) + feeEstimateZats(groups.map((g) => g.length));
  const { spendable, pending } = await shieldedBalance(wallet);
  if (plan.payouts.length > 0 && spendable < need) {
    // Refunds are paid in full, so fees come from raised funds or, when little
    // or nothing sold, from a fee float sent to the launch wallet (no memo).
    const advice = spendable + pending >= need
      ? "funds are still confirming (10 blocks for received payments); re-run shortly"
      : `send the launch wallet a fee float of at least ${need - spendable - pending} zatoshis (no memo), then re-run`;
    console.log(`  payouts waiting: need ~${need} zatoshis, ${spendable} spendable, ${pending} confirming: ${advice}`);
  } else {
    const deps = {
      pay: (uri: string) => (frost ? frostPayUri(wallet, frost, uri) : pay(wallet, uri)),
      refresh: () => refresh(wallet),
      chainTip: () => chainTip(wallet),
      readSent: () => readSent(db),
    };
    for (const batch of groups) {
      const r = await payBatch(batch, deps).catch((e: Error) => {
        // Each transaction locks its change until it confirms, so with several
        // batches later ones can run short. Nothing was sent.
        if (/Insufficient balance/.test(e.message)) return { status: "waiting" as const };
        throw e;
      });
      if (r.status === "waiting") {
        console.log("  payouts waiting: change from the payouts just sent is still confirming; re-run shortly");
        break;
      }
      if (r.status === "paid") console.log(`  paid ${batch.length} refunds/receipts in ${r.txid}`);
      else if (r.status === "in flight") console.log(`  ${batch.length} payouts sent but unconfirmed (connection dropped); they count once mined, or are re-paid by a later run if they expire`);
      else console.log(`  ${batch.length} payouts not sent (${r.error}); nothing went out, re-run close-launch`);
    }
  }
  console.log(`  payouts: ${plan.payouts.length} due, ${plan.alreadyPaid.length} already paid, ${plan.noAddress.length} owed with no address`);
}

if (s.raisedZats === 0n) {
  console.log("  nothing raised: no swap to price");
} else try {
  const q = await quoteZecToSol(s.raisedZats, creator.publicKey.toBase58());
  console.log(`  NEAR Intents live quote (mainnet price; not executed, NEAR Intents has no testnet): ${q.zecIn} ZEC -> ${q.solOut} SOL ($${Number(q.usdOut).toFixed(2)}), ~${q.secondsEstimate}s`);
} catch (e) {
  console.log(`  NEAR Intents quote unavailable: ${(e as Error).message}`);
}
