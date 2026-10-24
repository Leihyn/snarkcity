// Audits a launch with only public information and the launch's viewing key:
// reads the allocation root and allocated total from Solana, re-runs the
// auction from the Zcash chain, and checks the root, the total and every refund.
//
//   node scripts/audit-launch.ts <launch.public.json> <viewing-key-file> <watch-only-dir> <zcash-devtool>

import { readFileSync } from "node:fs";
import { auditLaunch, toJson } from "../src/audit-launch.ts";
import type { PublicTerms } from "../src/launch-file.ts";

const [termsPath, ufvkPath, dir, devtool] = process.argv.slice(2);
const terms: PublicTerms = JSON.parse(readFileSync(termsPath, "utf8"));
const report = await auditLaunch(terms, readFileSync(ufvkPath, "utf8").trim(), dir, devtool);
console.log(toJson(report));
process.exit(report.ok ? 0 : 2);
