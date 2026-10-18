// End-to-end claim on devnet for a launch that was settled on Zcash testnet.
//
//   node scripts/devnet-claim.ts <settlement.json> <supply-base-units> <bid-file>...
//
// Creates a fresh test mint and launch, posts the settlement's root, then has
// each bidder claim with the key from their bid file while the operator's
// wallet relays (pays fees and rent). Finally it tries every claim a second
// time, which must fail, and withdraws any unsold tokens.

import { createMint, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { buildClaim, claimKeyFromBidFile, createLaunch, loadKeypair, program, setRoot, withdrawUnsold, type Allocation } from "../src/client.ts";

const [settlementPath, supplyArg, ...bidFiles] = process.argv.slice(2);
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const operator = loadKeypair(`${homedir()}/.config/solana/id.json`); // creator and relayer for the demo
const p = program(connection, operator);
const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const settlement = JSON.parse(readFileSync(settlementPath, "utf8"));
const supply = BigInt(supplyArg);
const claims: Allocation[] = settlement.claims.map((c: { commitment: string; tokens: string; proof: string[] }) => ({
  commitment: c.commitment, tokens: BigInt(c.tokens), proof: c.proof,
}));

const mint = await createMint(connection, operator, operator.publicKey, null, 6);
const creatorAta = await getOrCreateAssociatedTokenAccount(connection, operator, mint, operator.publicKey);
await mintTo(connection, operator, mint, creatorAta.address, operator, supply);
const launchId = BigInt(Date.now());
console.log(`mint ${mint.toBase58()} | launch id ${launchId}`);
console.log(`create_launch: ${tx(await createLaunch(p, operator.publicKey, mint, launchId, supply))}`);
console.log(`set_root ${settlement.root.slice(0, 16)}…: ${tx(await setRoot(p, operator.publicKey, launchId, settlement.root, BigInt(settlement.tokensSold)))}`);

for (const file of bidFiles) {
  const { keypair: claimKey, salt, commitment } = claimKeyFromBidFile(file);
  const alloc = claims.find((c) => c.commitment === commitment);
  if (!alloc) { console.log(`${file}: no allocation (bid lost or arrived late), nothing to claim`); continue; }
  const sendClaim = async () => {
    const t = await buildClaim(p, operator.publicKey, claimKey.publicKey, operator.publicKey, mint, launchId, alloc, salt);
    t.partialSign(claimKey); // the bidder authorises
    t.partialSign(operator); // the relayer pays
    const sig = await connection.sendRawTransaction(t.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  };
  console.log(`claim ${alloc.tokens} for ${claimKey.publicKey.toBase58().slice(0, 8)}…: ${tx(await sendClaim())}`);
  const balance = (await getAccount(connection, getAssociatedTokenAddressSync(mint, claimKey.publicKey))).amount;
  console.log(`  recipient balance ${balance} (expected ${alloc.tokens}) ${balance === alloc.tokens ? "OK" : "MISMATCH"}`);
  try {
    await sendClaim();
    console.log("  second claim SUCCEEDED (bad: should have failed)");
  } catch (e) {
    console.log(`  second claim rejected as expected: ${String((e as Error).message).split("\n")[0].slice(0, 90)}`);
  }
}
console.log(`withdraw_unsold: ${tx(await withdrawUnsold(p, operator.publicKey, mint, launchId))}`);
