// Opens a launch: locks the token supply in the claim program's vault on
// Solana (so bidders can check the tokens exist), then opens the bidding
// window on Zcash starting at the next block.
//
//   node scripts/open-launch.ts <launch.json>
//
// Writes the filled-in launch file back, plus <launch>.public.json.

import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { join } from "node:path";
import { readReceived } from "../../watcher/src/bids.ts";
import { chainTip, defaultAddress, refresh } from "../../watcher/src/devtool.ts";
import { createLaunch, loadKeypair, program, PROGRAM_ID } from "../src/client.ts";
import { DRAND, roundAt, roundTime } from "../../web/src/seal.js";
import { expandHome, launchProblems, publicTerms, readLaunch, writeJson } from "../src/launch-file.ts";

// Zcash's target block time. The seal opens when the window is expected to
// close at this pace; if blocks run slow, bids mined after it opens are late
// (see bids.ts), so opening early never lets anyone act on what it reveals.
const TARGET_BLOCK_SECONDS = 75;

const path = process.argv[2];
const launch = readLaunch(path);
if (launch.solana.launchId) throw new Error(`${launch.name} is already open (launch id ${launch.solana.launchId})`);
const problems = launchProblems(launch);
if (problems.length > 0) throw new Error(`launch file problems:\n  ${problems.join("\n  ")}`);

const wallet = { bin: launch.zcash.devtool, dir: launch.zcash.walletDir };
await refresh(wallet);
if (readReceived(join(wallet.dir, "data.sqlite")).length > 0) {
  throw new Error("the launch wallet has already received payments; use a fresh wallet per launch");
}

const connection = new Connection(launch.solana.rpc, "confirmed");
const creator = loadKeypair(expandHome(launch.solana.keypair));
const supply = BigInt(launch.sale.supply);
let mint: PublicKey;
if (launch.solana.mint) {
  mint = new PublicKey(launch.solana.mint);
} else {
  mint = await createMint(connection, creator, creator.publicKey, null, launch.sale.decimals);
  const ata = await getOrCreateAssociatedTokenAccount(connection, creator, mint, creator.publicKey);
  await mintTo(connection, creator, mint, ata.address, creator, supply);
}
const launchId = BigInt(Date.now());
const sig = await createLaunch(program(connection, creator), creator.publicKey, mint, launchId, supply);

const tip = await chainTip(wallet);
launch.zcash.address = await defaultAddress(wallet);
launch.zcash.startHeight = tip + 1;
launch.zcash.endHeight = tip + launch.zcash.biddingBlocks;
Object.assign(launch.solana, { mint: mint.toBase58(), creator: creator.publicKey.toBase58(), launchId: launchId.toString() });
// Bids are sealed unless the launch file says "sealed": false.
if (launch.sealed !== false) {
  const round = roundAt(Math.floor(Date.now() / 1000) + launch.zcash.biddingBlocks * TARGET_BLOCK_SECONDS);
  launch.seal = { round, revealAt: roundTime(round), chainHash: DRAND.chainHash };
}
writeJson(path, launch);
const publicPath = path.replace(/\.json$/, ".public.json");
writeJson(publicPath, publicTerms(launch, PROGRAM_ID.toBase58()));

console.log(`${launch.name} (${launch.kind}) is open`);
console.log(`  supply locked on Solana: ${supply} base units of ${mint.toBase58()} (tx ${sig})`);
console.log(`  bids: Zcash blocks ${launch.zcash.startHeight}..${launch.zcash.endHeight} to ${launch.zcash.address.slice(0, 24)}…`);
if (launch.seal) console.log(`  bids sealed to drand round ${launch.seal.round}, which opens at ${new Date(launch.seal.revealAt * 1000).toISOString()}`);
else console.log(`  bids NOT sealed ("sealed": false): the launch wallet can read every price`);
console.log(`  public terms: ${publicPath}`);
