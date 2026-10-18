import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBidMemo, makeCommitment, parseBidMemo } from "../src/memo.ts";
import { buildLayers, proofFor, rootOf, verifyProof, type Allocation } from "../src/merkle.ts";

const C = "ab".repeat(32);

test("bid memo round-trips, with and without a refund address", () => {
  for (const m of [
    { commitment: C, maxPrice: 1234n },
    { commitment: C, maxPrice: 5n, refundTo: "utest1abc" },
  ]) {
    assert.deepEqual(parseBidMemo(formatBidMemo(m)), m);
  }
});

test("bid memo tolerates NUL padding from the 512-byte memo field", () => {
  assert.deepEqual(parseBidMemo(`SC1 BID c=${C} p=7` + "\0".repeat(40)), { commitment: C, maxPrice: 7n });
});

test("malformed memos are rejected, not guessed at", () => {
  for (const bad of [
    "hello",
    `SC1 BID c=${C.toUpperCase()} p=7`,
    `SC1 BID c=${C} p=0`,
    `SC1 BID c=${C.slice(2)} p=7`,
    `SC1 BID c=${C} p=7 r=utest1 extra`,
    `SC2 BID c=${C} p=7`,
  ]) {
    assert.equal(parseBidMemo(bad), null, bad);
  }
});

test("commitment checks its input sizes", () => {
  assert.match(makeCommitment(new Uint8Array(32), new Uint8Array(16)), /^[0-9a-f]{64}$/);
  assert.throws(() => makeCommitment(new Uint8Array(31), new Uint8Array(16)));
  assert.throws(() => makeCommitment(new Uint8Array(32), new Uint8Array(15)));
});

test("every allocation proves against the root, for tree sizes 1 to 9", () => {
  for (let n = 1; n <= 9; n++) {
    const allocs: Allocation[] = Array.from({ length: n }, (_, i) => ({
      commitment: i.toString(16).padStart(64, "0"),
      tokens: BigInt(1000 + i),
    }));
    const layers = buildLayers(allocs);
    allocs.forEach((a, i) => assert.ok(verifyProof(a, proofFor(layers, i), rootOf(layers)), `n=${n} i=${i}`));
  }
});

test("a proof does not verify a different token amount or commitment", () => {
  const allocs = [0, 1, 2].map((i) => ({ commitment: i.toString(16).padStart(64, "0"), tokens: 10n }));
  const layers = buildLayers(allocs);
  const proof = proofFor(layers, 1);
  assert.ok(!verifyProof({ ...allocs[1], tokens: 11n }, proof, rootOf(layers)));
  assert.ok(!verifyProof({ ...allocs[1], commitment: "f".repeat(64) }, proof, rootOf(layers)));
});
