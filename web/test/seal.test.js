import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAND, openBid, roundAt, roundTime, sealBid, sealedRound } from "../src/seal.js";

// Real drand quicknet beacons (api.drand.sh/<chainHash>/public/<round>), pinned
// so the tests run offline and prove compatibility with the live network.
const ROUND = 30000000;
const SIG = "81d2fc112b91932d9e4074a46b88c4dc78149b859660e0673c0bb9bd0caefdc9cc194e83de980441355b8ef44cc7a355";
const NEXT_SIG = "91d961babd09d50d150e4b179062e6fd0cabe647d09e5ab3bb1fe1d308056fd772eeadc6583128cd744361183e7d6f9b";
// The longest testnet unified address we expect (Ironwood/Orchard + Sapling + transparent receivers).
const LONG_UA = "utest1" + "q".repeat(250);
const bid = { commitment: "ab".repeat(32), maxPrice: 300n, refundTo: LONG_UA };

test("a sealed bid opens with its round's drand signature, and only then", async () => {
  const memo = await sealBid(bid, ROUND);
  assert.ok(memo.length <= 512, `${memo.length} bytes`);
  assert.equal(memo[0], 0xff, "ZIP 302 arbitrary-data memo");
  assert.equal(sealedRound(memo), ROUND);
  assert.deepEqual(await openBid(memo, SIG), bid);
  assert.equal(await openBid(memo, NEXT_SIG), null, "the next round's signature does not open it");
});

test("the memo hides the bid: no price or address in the clear", async () => {
  const memo = await sealBid({ ...bid, refundTo: "utest1visibleaddress" }, ROUND);
  const text = new TextDecoder().decode(memo);
  assert.ok(!text.includes("utest1visible"));
  assert.ok(!Buffer.from(memo).toString("hex").includes(bid.commitment), "commitment is encrypted too");
  const again = await sealBid({ ...bid, refundTo: "utest1visibleaddress" }, ROUND);
  assert.notDeepEqual(memo, again, "fresh randomness each time");
});

test("tampering is caught, including swapping the round", async () => {
  const memo = await sealBid(bid, ROUND);
  for (const at of [20, 175, 190, memo.length - 1]) {
    const bad = memo.slice();
    bad[at] ^= 1;
    assert.equal(await openBid(bad, SIG), null, `byte ${at}`);
  }
  const otherRound = memo.slice();
  new DataView(otherRound.buffer).setBigUint64(4, BigInt(ROUND + 1));
  assert.equal(await openBid(otherRound, SIG), null, "round is authenticated");
  assert.equal(await openBid(otherRound, NEXT_SIG), null);
});

test("memos padded to 512 bytes by the wallet still open; others are not sealed bids", async () => {
  const memo = await sealBid({ commitment: "01".repeat(32), maxPrice: 1n }, ROUND);
  const padded = new Uint8Array(512);
  padded.set(memo);
  assert.deepEqual(await openBid(padded, SIG), { commitment: "01".repeat(32), maxPrice: 1n });
  assert.equal(sealedRound(new TextEncoder().encode("SC1 BID c=00 p=1")), null);
  assert.equal(sealedRound(new Uint8Array(512)), null);
  assert.equal(await openBid(padded.slice(0, 100), SIG), null);
});

test("an address too long for the memo is refused when sealing", async () => {
  await assert.rejects(sealBid({ ...bid, refundTo: "u".repeat(400) }, ROUND), /Zcash memos hold 512/);
});

test("rounds map to drand's schedule", () => {
  assert.equal(roundTime(ROUND), DRAND.genesis + (ROUND - 1) * 3);
  assert.equal(roundAt(roundTime(ROUND)), ROUND);
  assert.equal(roundAt(roundTime(ROUND) + 1), ROUND + 1, "a time between rounds waits for the next");
});
