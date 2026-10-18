import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { claimKeyFromBidFile, launchPda, PROGRAM_ID, receiptPda, vaultPda } from "../src/client.ts";
import { makeCommitment } from "../../auction/src/memo.ts";

// Writes a bid file the same way watcher/scripts/make-bid.ts does.
function bidFile(tamper = false): { path: string; pubkey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const salt = randomBytes(16);
  const path = join(mkdtempSync(join(tmpdir(), "sc-bid-")), "bid.json");
  writeFileSync(path, JSON.stringify({
    claimPubkey: (tamper ? Keypair.generate().publicKey.toBuffer() : pubkey).toString("hex"),
    claimPrivateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("hex"),
    salt: salt.toString("hex"),
    commitment: makeCommitment(pubkey, salt),
  }));
  return { path, pubkey };
}

test("a bid file's claim key loads as the same Solana keypair", () => {
  const { path, pubkey } = bidFile();
  const { keypair, salt, commitment } = claimKeyFromBidFile(path);
  assert.deepEqual(keypair.publicKey.toBuffer(), pubkey);
  assert.equal(commitment, makeCommitment(pubkey, salt));
});

test("a bid file whose key does not match its public key is refused", () => {
  assert.throws(() => claimKeyFromBidFile(bidFile(true).path), /does not match/);
});

test("addresses follow the program's seeds and differ per launch and per commitment", () => {
  const creator = Keypair.generate().publicKey;
  const a = launchPda(creator, 1n);
  assert.notEqual(a.toBase58(), launchPda(creator, 2n).toBase58());
  assert.ok(PublicKey.isOnCurve(creator.toBuffer()) && !PublicKey.isOnCurve(a.toBuffer()), "PDAs are off the curve");
  assert.notEqual(vaultPda(a).toBase58(), a.toBase58());
  assert.notEqual(receiptPda(a, Buffer.alloc(32, 1)).toBase58(), receiptPda(a, Buffer.alloc(32, 2)).toBase58());
  assert.equal(PROGRAM_ID.toBase58(), "WA7VpLkfVh5HhCdfxHPosru9FEbTyUJUwUZhEkqe4Fu");
});
