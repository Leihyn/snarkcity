// Audits a launch from its viewing key alone. Builds (or reuses) a watch-only
// wallet, syncs it, and checks the auction result and every refund.
//
//   node scripts/audit.ts <launch.json> <ufvk-file> <watch-only-dir>
//
// launch.json holds the public launch terms and the published root:
//   { "devtool": "...", "startHeight": 0, "endHeight": 0, "supply": "...",
//     "decimals": 6, "reservePrice": "100", "publishedRoot": "<hex>" }

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBidMemo } from "../../auction/src/memo.ts";
import { readReceived, readSent } from "../src/bids.ts";
import { initWatchOnly, receivers, refresh } from "../src/devtool.ts";
import { audit } from "../src/audit.ts";

const [launchPath, ufvkPath, dir] = process.argv.slice(2);
const launch = JSON.parse(readFileSync(launchPath, "utf8"));
const wallet = { bin: launch.devtool, dir };

if (!existsSync(join(dir, "data.sqlite"))) {
  await initWatchOnly(wallet, readFileSync(ufvkPath, "utf8").trim(), launch.startHeight - 1);
}
await refresh(wallet);

const db = join(dir, "data.sqlite");
const received = readReceived(db);
const sent = readSent(db);

// Decode every address involved once, so the audit itself stays synchronous.
const addresses = new Set<string>();
for (const s of sent) if (s.toAddress) addresses.add(s.toAddress);
for (const r of received) {
  const refundTo = r.memo ? parseBidMemo(r.memo)?.refundTo : undefined;
  if (refundTo) addresses.add(refundTo);
}
const decoded = new Map<string, string[]>();
for (const a of addresses) decoded.set(a, await receivers(launch.devtool, a));

const report = audit({
  received,
  sent,
  window: { startHeight: launch.startHeight, endHeight: launch.endHeight },
  params: { supply: BigInt(launch.supply), decimals: launch.decimals, reservePrice: BigInt(launch.reservePrice) },
  publishedRoot: launch.publishedRoot ?? null,
  sameRecipient: (paidTo, named) => {
    const ofNamed = new Set(decoded.get(named) ?? [named]);
    return (decoded.get(paidTo) ?? [paidTo]).every((r) => ofNamed.has(r));
  },
});
console.log(JSON.stringify(report, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
process.exit(report.ok ? 0 : 2);
