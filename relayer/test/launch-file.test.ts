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

test("pool sizing: the raise buys tokens at the clearing price, SOL parses exactly", async () => {
  const { lamportsOf, poolTokens } = await import("../src/pool.ts");
  assert.equal(poolTokens(200_000n, { num: 100n, den: 1n }, 6), 2_000_000_000n, "0.002 ZEC at 100 zats per token is 2,000 tokens");
  assert.equal(poolTokens(1_000n, { num: 3n, den: 1n }, 0), 333n, "rounds down");
  assert.equal(lamportsOf("0.022856557"), 22_856_557n);
  assert.equal(lamportsOf("1"), 1_000_000_000n);
  assert.equal(lamportsOf("0.0000000019"), 1n, "beyond 9 decimals is cut, not rounded up");
  assert.throws(() => lamportsOf("-1"), /not a SOL amount/);
});
