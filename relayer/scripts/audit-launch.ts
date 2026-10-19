// Audits a launch with only public information and the launch's viewing key:
// reads the allocation root and allocated total from Solana, re-runs the
// auction from the Zcash chain, and checks the root, the total and every refund.
//
//   node scripts/audit-launch.ts <launch.public.json> <ufvk-file> <watch-only-dir> <zcash-devtool>

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { runAudit } from "../../watcher/src/run-audit.ts";
import { fetchLaunch, program } from "../src/client.ts";
import type { PublicTerms } from "../src/launch-file.ts";

const [termsPath, ufvkPath, dir, devtool] = process.argv.slice(2);
const terms: PublicTerms = JSON.parse(readFileSync(termsPath, "utf8"));

// Reading needs no signer; any keypair satisfies the client.
const p = program(new Connection(terms.rpc, "confirmed"), Keypair.generate());
const onChain = await fetchLaunch(p, new PublicKey(terms.creator), BigInt(terms.launchId));

const report = await runAudit({
  devtool,
  ufvk: readFileSync(ufvkPath, "utf8").trim(),
  dir,
  window: { startHeight: terms.startHeight, endHeight: terms.endHeight },
  params: { supply: BigInt(terms.supply), decimals: terms.decimals, reservePrice: BigInt(terms.reservePrice) },
  publishedRoot: onChain.root,
});
const allocatedMatches = onChain.allocated === report.tokensSold;
const supplyMatches = onChain.supply === BigInt(terms.supply) && onChain.mint === terms.mint;
// Not finalized means the creator has not yet posted a root or closed without
// sale; a null root would otherwise look like "nothing sold".
const ok = onChain.finalized && report.ok && allocatedMatches && supplyMatches;
console.log(
  JSON.stringify(
    // `ok` goes last: report.ok covers only the Zcash side and must not overwrite it.
    { ...report, onChain: { ...onChain, allocatedMatches, supplyMatches }, ok },
    (_, x) => (typeof x === "bigint" ? x.toString() : x),
    2,
  ),
);
process.exit(ok ? 0 : 2);
