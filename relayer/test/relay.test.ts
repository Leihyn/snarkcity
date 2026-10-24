import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { makeClaimKey } from "../../web/src/bid.js";
import { b64, readBidFile, recipientProblem, signClaim } from "../../web/src/claim.js";
import { base58, claimMessageProblem, decodeAddress } from "../../web/src/solana.js";
import { buildClaim, program, PROGRAM_ID } from "../src/client.ts";
import { ClaimRelay } from "../src/relay.ts";

// Stands in for the Solana RPC: hands out a blockhash, records what is sent.
function fakeConnection(claimed = false) {
  const sent: Buffer[] = [];
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    getAccountInfo: async () => (claimed ? { data: Buffer.alloc(0) } : null),
    sendRawTransaction: async (raw: Buffer) => { sent.push(raw); return "txid"; },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  return { conn: conn as unknown as Connection, sent };
}

const relayer = Keypair.generate();
const terms = {
  name: "Moth", kind: "memecoin", bidAddress: "utest1x", startHeight: 1, endHeight: 30, supply: "1000", decimals: 6, reservePrice: "100",
  programId: PROGRAM_ID.toBase58(), rpc: "http://localhost", mint: Keypair.generate().publicKey.toBase58(),
  creator: Keypair.generate().publicKey.toBase58(), launchId: "42",
};

async function bidder() {
  const key = await makeClaimKey();
  const bid = await readBidFile(JSON.stringify({ ...key, launch: { launchId: "42", name: "Moth" } }));
  const req = { commitment: key.commitment, claimPubkey: key.claimPubkey, salt: key.salt };
  return { bid, req, claims: [{ commitment: key.commitment, tokens: "2000", proof: [] }] };
}

test("base58 addresses match @solana/web3.js", () => {
  for (let i = 0; i < 20; i++) {
    const pk = Keypair.generate().publicKey;
    assert.equal(base58(pk.toBytes()), pk.toBase58());
    assert.deepEqual(decodeAddress(pk.toBase58()), pk.toBytes());
  }
  assert.equal(base58(new Uint8Array(32)), "11111111111111111111111111111111");
  assert.equal(decodeAddress("not an address"), null);
  assert.equal(decodeAddress("0OIl"), null);
  assert.equal(recipientProblem(""), null);
  assert.match(recipientProblem("abc") ?? "", /not a Solana address/);
});

test("a browser-signed claim is co-signed and sent, paying the chosen wallet", async () => {
  const { conn, sent } = fakeConnection();
  const relay = new ClaimRelay(conn, relayer);
  const { bid, req, claims } = await bidder();
  const wallet = Keypair.generate().publicKey.toBase58();
  const prepared = await relay.prepare(terms, claims, { ...req, recipient: wallet });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.equal(prepared.recipient, wallet);
  const signed = await signClaim(bid, b64.decode(prepared.message), { programId: terms.programId, recipient: wallet, mint: terms.mint });
  assert.ok(signed.signature, signed.problem);
  assert.equal(await relay.submit(prepared.message, b64.encode(signed.signature!)), "txid");
  const tx = Transaction.from(sent[0]);
  assert.ok(tx.verifySignatures(), "both the claim key and the relayer signed");
  assert.equal(tx.feePayer?.toBase58(), relayer.publicKey.toBase58());
  await assert.rejects(relay.submit(prepared.message, b64.encode(signed.signature!)), /expired/, "a claim is sent once");
});

test("the browser refuses to sign a claim that pays someone else", async () => {
  const { conn } = fakeConnection();
  const relay = new ClaimRelay(conn, relayer);
  const { bid, req, claims } = await bidder();
  const mine = Keypair.generate().publicKey.toBase58();
  const prepared = await relay.prepare(terms, claims, { ...req, recipient: Keypair.generate().publicKey.toBase58() });
  if (prepared.status !== "ready") throw new Error("not ready");
  const bytes = b64.decode(prepared.message);
  assert.match((await signClaim(bid, bytes, { programId: terms.programId, recipient: mine, mint: terms.mint })).problem ?? "", /token account is for/);
  assert.match(claimMessageProblem(bytes, { programId: terms.programId, claimer: bid.claimAddress, recipient: prepared.recipient, mint: Keypair.generate().publicKey.toBase58() }) ?? "", /different token/);
  assert.match(claimMessageProblem(bytes, { programId: Keypair.generate().publicKey.toBase58(), claimer: bid.claimAddress, recipient: prepared.recipient, mint: terms.mint }) ?? "", /not the claim program/);
  assert.match(claimMessageProblem(bytes.subarray(0, 50), { programId: terms.programId, claimer: bid.claimAddress, recipient: prepared.recipient, mint: terms.mint }) ?? "", /truncated/);
});

test("with no wallet given, the tokens go to the claim key's own address", async () => {
  const { conn } = fakeConnection();
  const { bid, req, claims } = await bidder();
  const prepared = await new ClaimRelay(conn, relayer).prepare(terms, claims, req);
  if (prepared.status !== "ready") throw new Error("not ready");
  assert.equal(prepared.recipient, bid.claimAddress);
  assert.equal(new PublicKey(bid.claimAddress).toBuffer().toString("hex"), req.claimPubkey);
});

test("the relay refuses bad signatures, unknown messages and mismatched keys", async () => {
  const { conn, sent } = fakeConnection();
  const relay = new ClaimRelay(conn, relayer);
  const { req, claims } = await bidder();
  const prepared = await relay.prepare(terms, claims, req);
  if (prepared.status !== "ready") throw new Error("not ready");
  await assert.rejects(relay.submit(prepared.message, b64.encode(new Uint8Array(64))), /does not match your claim key/);
  await assert.rejects(relay.submit(Buffer.from("other").toString("base64"), b64.encode(new Uint8Array(64))), /expired/);
  await assert.rejects(relay.submit(prepared.message, "AAAA"), /malformed signature/);
  assert.equal(sent.length, 0, "nothing was sent");
  const other = await bidder();
  await assert.rejects(relay.prepare(terms, claims, { ...req, claimPubkey: other.req.claimPubkey }), /does not match the commitment/);
  assert.deepEqual(await relay.prepare(terms, [], req), { status: "no-allocation" });
  assert.deepEqual(await new ClaimRelay(fakeConnection(true).conn, relayer).prepare(terms, claims, req), { status: "claimed" });
});

test("a damaged bid file is caught before anything is sent", async () => {
  const key = await makeClaimKey();
  assert.match((await readBidFile("{")).problem ?? "", /not JSON/);
  assert.match((await readBidFile(JSON.stringify({ ...key, salt: "00".repeat(16) }))).problem ?? "", /does not match its commitment/);
  assert.match((await readBidFile(JSON.stringify({ ...key, claimPrivateKeyPkcs8: "zz" }))).problem ?? "", /missing or damaged/);
  const ok = await readBidFile(JSON.stringify(key));
  assert.equal(ok.launchId, null, "command-line bid files carry no launch");
});

test("the browser refuses a claim that creates your account but pays into another", async () => {
  const { conn } = fakeConnection();
  const { bid, req } = await bidder();
  const p = program(conn, relayer);
  const build = (owner: PublicKey) => buildClaim(
    p, relayer.publicKey, new PublicKey(bid.claimAddress), new PublicKey(terms.creator), new PublicKey(terms.mint), 42n,
    { commitment: req.commitment, tokens: 2000n, proof: [] }, Buffer.from(req.salt, "hex"), owner,
  );
  const mine = Keypair.generate().publicKey, theirs = Keypair.generate().publicKey;
  const forged = new Transaction().add((await build(mine)).instructions[0], (await build(theirs)).instructions[1]);
  forged.feePayer = relayer.publicKey;
  forged.recentBlockhash = Keypair.generate().publicKey.toBase58();
  const expect = { programId: terms.programId, recipient: mine.toBase58(), mint: terms.mint };
  assert.match((await signClaim(bid, forged.serializeMessage(), expect)).problem ?? "", /pays a different token account/);
  const honest = new Transaction().add(...(await build(mine)).instructions);
  honest.feePayer = relayer.publicKey;
  honest.recentBlockhash = forged.recentBlockhash;
  assert.ok((await signClaim(bid, honest.serializeMessage(), expect)).signature);
});
