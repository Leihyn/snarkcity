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
import { chainTip, pay, refresh, shieldedBalance } from "../../watcher/src/devtool.ts";
import { batches, feeEstimateZats, planPayouts, toPaymentUri, withLateBids } from "../../watcher/src/payouts.ts";
import { settle } from "../../watcher/src/settle.ts";
import { closeWithoutSale, fetchLaunch, loadKeypair, program, setRoot, withdrawUnsold } from "../src/client.ts";
import { expandHome, readLaunch, writeJson } from "../src/launch-file.ts";
import { quoteZecToSol } from "../src/near.ts";

const [path, flag] = process.argv.slice(2);
const launch = readLaunch(path);
const { startHeight, endHeight, identity } = launch.zcash;
if (startHeight === undefined || endHeight === undefined || !launch.solana.launchId) throw new Error("launch is not open");

const wallet = { bin: launch.zcash.devtool, dir: launch.zcash.walletDir, identity };
await refresh(wallet);
const tip = await chainTip(wallet);
if (tip <= endHeight) throw new Error(`bidding is still open: chain at ${tip}, window ends at ${endHeight}`);

const db = join(wallet.dir, "data.sqlite");
const scan = scanBids(readReceived(db), { startHeight, endHeight });
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
const unsold = BigInt(launch.sale.supply) - s.tokensSold;
const after = await fetchLaunch(p, creator.publicKey, launchId);
if (unsold > 0n && !after.unsoldWithdrawn) {
  const mint = new PublicKey(launch.solana.mint!);
  console.log(`  ${unsold} unsold tokens returned to the creator: ${await withdrawUnsold(p, creator.publicKey, mint, launchId)}`);
}

if (flag !== "--no-payout") {
  const plan = planPayouts(withLateBids(s.outcomes, scan.rejected), s.price, readSent(db));
  const groups = batches(plan.payouts, 8);
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
    for (const batch of groups) console.log(`  paid ${batch.length} refunds/receipts in ${await pay(wallet, toPaymentUri(batch))}`);
  }
  console.log(`  payouts: ${plan.payouts.length} due, ${plan.alreadyPaid.length} already paid, ${plan.noAddress.length} owed with no address`);
}

if (s.raisedZats === 0n) {
  console.log("  nothing raised: no swap to price");
} else try {
  const q = await quoteZecToSol(s.raisedZats, creator.publicKey.toBase58());
  console.log(`  NEAR Intents live quote: ${q.zecIn} ZEC -> ${q.solOut} SOL ($${Number(q.usdOut).toFixed(2)}), ~${q.secondsEstimate}s`);
} catch (e) {
  console.log(`  NEAR Intents quote unavailable: ${(e as Error).message}`);
}
