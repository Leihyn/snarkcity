// Operator tool for one launch.
//
//   node scripts/launch.ts <config.json> scan               refresh the wallet and list bids
//   node scripts/launch.ts <config.json> settle             run the auction and write the settlement
//   node scripts/launch.ts <config.json> payout [--dry-run] pay refunds and receipts
//
// config.json:
//   { "devtool": "...", "walletDir": "...", "identity": "...", "startHeight": 0, "endHeight": 0,
//     "supply": "1000000000000", "decimals": 6, "reservePrice": "100", "out": "settlement.json" }

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readReceived, readSent, scanBids } from "../src/bids.ts";
import { pay, refresh } from "../src/devtool.ts";
import { batches, planPayouts, toPaymentUri, withLateBids } from "../src/payouts.ts";
import { settle } from "../src/settle.ts";

const [configPath, command, flag] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const wallet = { bin: cfg.devtool, dir: cfg.walletDir, identity: cfg.identity };
const db = join(cfg.walletDir, "data.sqlite");
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const PAYOUTS_PER_TX = 8;

await refresh(wallet);
const scan = scanBids(readReceived(db), { startHeight: cfg.startHeight, endHeight: cfg.endHeight });
const settlement = () =>
  settle(scan.bids, { supply: BigInt(cfg.supply), decimals: cfg.decimals, reservePrice: BigInt(cfg.reservePrice) });

if (command === "scan") {
  console.log(json({ bids: scan.bids, rejected: scan.rejected }));
} else if (command === "settle") {
  const s = settlement();
  writeFileSync(cfg.out, json({ ...s, rejected: scan.rejected }));
  console.log(`settled: ${scan.bids.length} bids, root ${s.root}, written to ${cfg.out}`);
} else if (command === "payout") {
  const s = settlement();
  const plan = planPayouts(withLateBids(s.outcomes, scan.rejected), s.price, readSent(db));
  console.log(json({ toPay: plan.payouts.length, alreadyPaid: plan.alreadyPaid.length, noAddress: plan.noAddress }));
  for (const batch of batches(plan.payouts, PAYOUTS_PER_TX)) {
    for (const p of batch) console.log(`  ${p.zats} zats -> ${p.to.slice(0, 16)}…  ${p.memo.slice(0, 60)}`);
    if (flag === "--dry-run") continue;
    console.log(`  paid in tx ${await pay(wallet, toPaymentUri(batch))}`);
  }
} else {
  console.error("command must be scan, settle or payout");
  process.exit(1);
}
