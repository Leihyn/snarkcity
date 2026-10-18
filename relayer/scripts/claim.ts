// A bidder claims their tokens for a closed launch. The relayer (the operator's
// wallet here) pays fees and rent; the claim key from the bid file signs.
//
//   node scripts/claim.ts <launch.public.json> <settlement.json> <bid-file> <relayer-keypair>

import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { buildClaim, claimKeyFromBidFile, loadKeypair, program } from "../src/client.ts";
import { expandHome, type PublicTerms } from "../src/launch-file.ts";

const [termsPath, settlementPath, bidPath, relayerPath] = process.argv.slice(2);
const terms: PublicTerms = JSON.parse(readFileSync(termsPath, "utf8"));
const settlement = JSON.parse(readFileSync(settlementPath, "utf8"));
const connection = new Connection(terms.rpc, "confirmed");
const relayer = loadKeypair(expandHome(relayerPath));
const { keypair: claimKey, salt, commitment } = claimKeyFromBidFile(bidPath);

const entry = settlement.claims.find((c: { commitment: string }) => c.commitment === commitment);
if (!entry) {
  console.log("no allocation for this bid (it lost or arrived late); its ZEC was refunded on Zcash");
  process.exit(0);
}
const mint = new PublicKey(terms.mint);
const tx = await buildClaim(
  program(connection, relayer), relayer.publicKey, claimKey.publicKey, new PublicKey(terms.creator), mint,
  BigInt(terms.launchId), { commitment, tokens: BigInt(entry.tokens), proof: entry.proof }, salt,
);
tx.partialSign(claimKey);
tx.partialSign(relayer);
const sig = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction(sig, "confirmed");
const balance = (await getAccount(connection, getAssociatedTokenAddressSync(mint, claimKey.publicKey))).amount;
console.log(`claimed ${entry.tokens} to ${claimKey.publicKey.toBase58()} (balance ${balance}) in ${sig}`);
