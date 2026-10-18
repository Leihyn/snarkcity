// Writes test vectors for the Solana claim program, produced by this package's
// own memo and merkle code. The program's native tests check that its hashing
// reproduces them exactly.
//
//   node scripts/gen-vectors.ts ../program/programs/snark_claim/tests/fixtures/merkle_vectors.json

import { writeFileSync } from "node:fs";
import { makeCommitment } from "../src/memo.ts";
import { buildLayers, proofFor, rootOf } from "../src/merkle.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: gen-vectors.ts <out.json>");

// Fixed, obviously fake keys and salts: byte i of key k is (k * 31 + i) mod 256.
const bytes = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);
const entries = Array.from({ length: 5 }, (_, k) => {
  const claimPubkey = bytes(32, (i) => k * 31 + i);
  const salt = bytes(16, (i) => k * 7 + i * 3);
  return { claimPubkey, salt, commitment: makeCommitment(claimPubkey, salt), tokens: BigInt(1_000_000 * (k + 1)) + 7n };
});

const layers = buildLayers(entries.map((e) => ({ commitment: e.commitment, tokens: e.tokens })));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
writeFileSync(
  out,
  JSON.stringify(
    {
      root: rootOf(layers).toString("hex"),
      claims: entries.map((e, i) => ({
        claim_pubkey: hex(e.claimPubkey),
        salt: hex(e.salt),
        commitment: e.commitment,
        tokens: e.tokens.toString(),
        proof: proofFor(layers, i).map((h) => h.toString("hex")),
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${entries.length} claims to ${out}`);
