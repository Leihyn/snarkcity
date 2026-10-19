import { test } from "node:test";
import assert from "node:assert/strict";
import { launchProblems, MIN_BIDDING_BLOCKS, type LaunchFile } from "../src/launch-file.ts";

const launch = (biddingBlocks: number, supply = "1000", reservePrice = "100"): LaunchFile => ({
  name: "T", kind: "memecoin",
  zcash: { devtool: "d", walletDir: "w", identity: "i", biddingBlocks },
  sale: { supply, decimals: 6, reservePrice },
  solana: { rpc: "r", keypair: "k" },
});

test("bidding windows shorter than the minimum are refused", () => {
  assert.deepEqual(launchProblems(launch(MIN_BIDDING_BLOCKS)), []);
  assert.match(launchProblems(launch(5))[0], /at least 20/);
  assert.match(launchProblems(launch(19))[0], /at least 20/);
  assert.equal(launchProblems(launch(20.5)).length, 1, "whole blocks only");
});

test("a zero supply is refused", () => {
  assert.match(launchProblems(launch(30, "0"))[0], /supply/);
});
