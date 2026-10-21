import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseOf } from "../src/phase.ts";
import { launchStatus } from "../src/status.ts";
import type { PublicTerms } from "../src/launch-file.ts";

const at = (zcashTip: number, finalized = false, noSale = false) =>
  phaseOf({ zcashTip, startHeight: 100, endHeight: 120, finalized, noSale });

test("a launch moves lot -> bidding -> settling -> live or no sale", () => {
  assert.equal(at(99), "lot");
  assert.equal(at(100), "bidding");
  assert.equal(at(120), "bidding", "the end block still accepts bids");
  assert.equal(at(121), "settling");
  assert.equal(at(130, true), "live");
  assert.equal(at(130, true, true), "no sale");
});

const terms: PublicTerms = {
  name: "T", kind: "memecoin", bidAddress: "utest1x", startHeight: 100, endHeight: 120,
  supply: "1000", decimals: 6, reservePrice: "100", programId: "p", rpc: "r", mint: "m", creator: "c", launchId: "1",
};
const settlement = { price: { num: "400", den: "1" }, tokensSold: "1000", raisedZats: "400000", bids: 2 };
const chain = (finalized: boolean, noSale = false) => ({
  creator: "c", mint: "m", supply: 1000n, root: finalized && !noSale ? "aa" : null, noSale, finalized,
  allocated: finalized && !noSale ? 1000n : 0n, claimed: 250n, unsoldWithdrawn: false,
});

test("the result is hidden until it is final on Solana", () => {
  const settling = launchStatus(terms, 125, chain(false), settlement);
  assert.equal(settling.phase, "settling");
  assert.equal(settling.result, null, "a settlement file alone is not enough");
  const live = launchStatus(terms, 125, chain(true), settlement);
  assert.equal(live.phase, "live");
  assert.deepEqual(live.result, settlement);
  assert.deepEqual(live.solana, { finalized: true, noSale: false, allocated: "1000", claimed: "250" });
});

test("blocks left and blocks to start never go negative", () => {
  assert.deepEqual([launchStatus(terms, 90, null, null).blocksToStart, launchStatus(terms, 90, null, null).blocksLeft], [10, 30]);
  assert.deepEqual([launchStatus(terms, 200, null, null).blocksToStart, launchStatus(terms, 200, null, null).blocksLeft], [0, 0]);
});
