import { test } from "node:test";
import assert from "node:assert/strict";
import { floorsFor, litFraction, pricePerToken, signLines, tokens, zec, MAX_FLOORS, MIN_FLOORS } from "../src/view-model.js";

const base = { name: "Fogcoin", supply: "1000000000", decimals: 6, blocksLeft: 7, blocksToStart: 3 };

test("amounts read as ZEC and whole tokens", () => {
  assert.equal(zec("400000"), "0.004");
  assert.equal(zec("100000000"), "1");
  assert.equal(zec("0"), "0");
  assert.equal(pricePerToken({ num: "400", den: "1" }), "0.000004");
  assert.equal(pricePerToken({ num: "500000000", den: "100000000" }), "0.00000005");
  assert.equal(pricePerToken(null), null);
  assert.equal(tokens("750000000", 6), "750");
});

test("a tower's height shows the share sold, and only once live", () => {
  const live = (sold) => ({ ...base, phase: "live", result: { tokensSold: sold } });
  assert.equal(floorsFor(live("1000000000")), MAX_FLOORS);
  assert.equal(floorsFor(live("1")), MIN_FLOORS, "a tiny sale still gets a building");
  assert.equal(floorsFor({ ...base, phase: "bidding", result: null }), 0, "nothing to show while sealed");
  assert.equal(floorsFor({ ...base, phase: "settling", result: { tokensSold: "1000000000" } }), 0);
});

test("windows light up as tokens are claimed", () => {
  assert.equal(litFraction({ solana: { allocated: "1000", claimed: "250" } }), 0.25);
  assert.equal(litFraction({ solana: { allocated: "0", claimed: "0" } }), 0);
  assert.equal(litFraction({ solana: null }), 0);
});

test("the sign tells the phase without revealing demand", () => {
  assert.deepEqual(signLines({ ...base, phase: "lot" }), ["FOGCOIN", "SUPPLY LOCKED · OPENS IN 3 BLOCKS"]);
  assert.deepEqual(signLines({ ...base, phase: "bidding" }), ["FOGCOIN", "SEALED BIDS · 7 BLOCKS LEFT"]);
  assert.deepEqual(signLines({ ...base, phase: "settling" }), ["FOGCOIN", "SEALED · COUNTING"]);
  assert.deepEqual(signLines({ ...base, phase: "no sale" }), ["FOGCOIN", "NO SALE · SUPPLY RETURNED"]);
  assert.deepEqual(
    signLines({ ...base, phase: "live", result: { price: { num: "400", den: "1" }, tokensSold: "1000000000" } }),
    ["FOGCOIN", "0.000004 ZEC · 100% SOLD"],
  );
});
