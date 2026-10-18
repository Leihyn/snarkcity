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
import { expandHome, publicTerms, readLaunch, writeJson } from "../src/launch-file.ts";

const path = process.argv[2];
const launch = readLaunch(path);
if (launch.solana.launchId) throw new Error(`${launch.name} is already open (launch id ${launch.solana.launchId})`);

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
writeJson(path, launch);
const publicPath = path.replace(/\.json$/, ".public.json");
writeJson(publicPath, publicTerms(launch, PROGRAM_ID.toBase58()));

console.log(`${launch.name} (${launch.kind}) is open`);
console.log(`  supply locked on Solana: ${supply} base units of ${mint.toBase58()} (tx ${sig})`);
console.log(`  bids: Zcash blocks ${launch.zcash.startHeight}..${launch.zcash.endHeight} to ${launch.zcash.address.slice(0, 24)}…`);
console.log(`  public terms: ${publicPath}`);
