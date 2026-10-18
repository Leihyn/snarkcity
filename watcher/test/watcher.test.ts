import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMemo, readReceived, scanBids, type ReceivedOutput } from "../src/bids.ts";
import { settle } from "../src/settle.ts";
import { verifyProof } from "../../auction/src/merkle.ts";

const C1 = "11".repeat(32);
const C2 = "22".repeat(32);

// A stand-in for zcash-devtool's wallet DB with the same v_tx_outputs columns.
function fakeWalletDb(rows: (Buffer | number | string | null)[][]): string {
  const path = join(mkdtempSync(join(tmpdir(), "sc-watch-")), "data.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE v_tx_outputs (txid BLOB, output_index INT, tx_mined_height INT, value INT,
           memo BLOB, to_account_uuid TEXT, is_change INT)`);
  const ins = db.prepare("INSERT INTO v_tx_outputs VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) ins.run(...r);
  db.close();
  return path;
}

test("reads received outputs, reversing txids to display order and skipping change and sends", () => {
  const stored = Buffer.from("4a1c" + "00".repeat(30), "hex"); // DB byte order
  const path = fakeWalletDb([
    [stored, 0, 100, 1_000_000, Buffer.from(`SC1 BID c=${C1} p=8`), "acct", 0],
    [stored, 1, 100, 500, Buffer.from("change"), "acct", 1],
    [stored, 2, 100, 700, Buffer.from("sent"), null, 0],
  ]);
  const out = readReceived(path);
  assert.equal(out.length, 1);
  assert.equal(out[0].txid, "00".repeat(30) + "1c4a");
  assert.equal(out[0].valueZats, 1_000_000n);
  assert.equal(out[0].memo, `SC1 BID c=${C1} p=8`);
});

test("non-text memos decode to null (ZIP 302)", () => {
  assert.equal(decodeMemo(Uint8Array.from([0xf6, ...new Array(511).fill(0)])), null);
  assert.equal(decodeMemo(Uint8Array.from([0xff, 1, 2])), null);
  assert.equal(decodeMemo(null), null);
  assert.equal(decodeMemo(Buffer.from("hi\0\0")), "hi");
});

test("scanBids keeps only mined, in-window payments with a valid bid memo", () => {
  const o = (txid: string, h: number | null, memo: string | null): ReceivedOutput =>
    ({ txid, outputIndex: 0, minedHeight: h, valueZats: 100n, memo });
  const scan = scanBids(
    [
      o("a", 150, `SC1 BID c=${C1} p=8 r=utest1x`),
      o("b", null, `SC1 BID c=${C1} p=8`),
      o("c", 99, `SC1 BID c=${C1} p=8`),
      o("d", 201, `SC1 BID c=${C1} p=8`),
      o("e", 150, "thanks for the coffee"),
      o("f", 150, null),
    ],
    { startHeight: 100, endHeight: 200 },
  );
  assert.deepEqual(scan.bids.map((b) => [b.txid, b.refundTo]), [["a:0", "utest1x"]]);
  assert.deepEqual(scan.rejected.map((r) => r.reason), ["unmined", "outside window", "outside window", "no bid memo", "no bid memo"]);
});

test("settle produces claims that verify against the root, and refunds for the rest", () => {
  // Same numbers as the auction's oversubscribed case: price 8, a gets 75, b gets 25.
  const bids = [
    { txid: "a:0", amountZats: 600n, maxPrice: 10n, commitment: C1, refundTo: "utest1a" },
    { txid: "b:0", amountZats: 300n, maxPrice: 8n, commitment: C2, refundTo: "utest1b" },
    { txid: "c:0", amountZats: 400n, maxPrice: 5n, commitment: "33".repeat(32) },
  ];
  const s = settle(bids, { supply: 100n, decimals: 0, reservePrice: 1n });
  assert.equal(s.tokensSold, 100n);
  assert.deepEqual(s.claims.map((c) => [c.commitment, c.tokens]), [[C1, 75n], [C2, 25n]]);
  for (const c of s.claims) {
    const proof = c.proof.map((h) => Buffer.from(h, "hex"));
    assert.ok(verifyProof(c, proof, Buffer.from(s.root!, "hex")));
  }
  assert.deepEqual(s.outcomes, [
    { bidId: "a:0", refundTo: "utest1a", tokens: 75n, refundZats: 0n },
    { bidId: "b:0", refundTo: "utest1b", tokens: 25n, refundZats: 100n },
    { bidId: "c:0", refundTo: null, tokens: 0n, refundZats: 400n },
  ]);
});

test("a reused claim key gets one leaf with the tokens summed", () => {
  const bids = [
    { txid: "a:0", amountZats: 300n, maxPrice: 10n, commitment: C1 },
    { txid: "a:1", amountZats: 200n, maxPrice: 10n, commitment: C1 },
  ];
  const s = settle(bids, { supply: 100n, decimals: 0, reservePrice: 1n });
  assert.deepEqual(s.claims.map((c) => [c.commitment, c.tokens]), [[C1, 100n]]);
});

test("the root does not depend on the order bids arrived in", () => {
  const bids = [
    { txid: "a:0", amountZats: 300n, maxPrice: 10n, commitment: C1 },
    { txid: "b:0", amountZats: 200n, maxPrice: 9n, commitment: C2 },
  ];
  const p = { supply: 100n, decimals: 0, reservePrice: 1n };
  assert.equal(settle(bids, p).root, settle([...bids].reverse(), p).root);
});
