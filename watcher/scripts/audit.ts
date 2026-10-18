// Audits a launch from its viewing key alone, against a root given in the
// launch file. (relayer/scripts/audit-launch.ts reads the root from Solana.)
//
//   node scripts/audit.ts <launch.json> <ufvk-file> <watch-only-dir>
//
// launch.json holds the public launch terms and the published root:
//   { "devtool": "...", "startHeight": 0, "endHeight": 0, "supply": "...",
//     "decimals": 6, "reservePrice": "100", "publishedRoot": "<hex>" }

import { readFileSync } from "node:fs";
import { runAudit } from "../src/run-audit.ts";

const [launchPath, ufvkPath, dir] = process.argv.slice(2);
const launch = JSON.parse(readFileSync(launchPath, "utf8"));

const report = await runAudit({
  devtool: launch.devtool,
  ufvk: readFileSync(ufvkPath, "utf8").trim(),
  dir,
  window: { startHeight: launch.startHeight, endHeight: launch.endHeight },
  params: { supply: BigInt(launch.supply), decimals: launch.decimals, reservePrice: BigInt(launch.reservePrice) },
  publishedRoot: launch.publishedRoot ?? null,
});
console.log(JSON.stringify(report, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
process.exit(report.ok ? 0 : 2);
