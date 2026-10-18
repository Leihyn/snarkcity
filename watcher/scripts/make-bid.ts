// Creates a bid: a fresh ed25519 claim key (the key type Solana uses) and a
// random salt, committed to as sha256(pubkey || salt). The key and salt are
// written to a private file the bidder keeps; only the memo is printed.
//
//   node scripts/make-bid.ts <out-file> <max-price-zats-per-token> [refund-address]

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { formatBidMemo, makeCommitment } from "../../auction/src/memo.ts";

const [outFile, maxPrice, refundTo] = process.argv.slice(2);
if (!outFile || !maxPrice) {
  console.error("usage: make-bid.ts <out-file> <max-price> [refund-address]");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
// The last 32 bytes of the SPKI DER encoding are the raw ed25519 public key.
const pubkey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const salt = randomBytes(16);
const commitment = makeCommitment(pubkey, salt);

writeFileSync(
  outFile,
  JSON.stringify({
    claimPubkey: pubkey.toString("hex"),
    claimPrivateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("hex"),
    salt: salt.toString("hex"),
    commitment,
  }),
  { mode: 0o600 },
);
console.log(formatBidMemo({ commitment, maxPrice: BigInt(maxPrice), refundTo }));
