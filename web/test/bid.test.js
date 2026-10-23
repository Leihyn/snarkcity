import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bidFile, bidMemo, checkBid, formatZec, makeClaimKey, parseZec, paymentUri, timing, LATE_BID_MARGIN } from "../src/bid.js";
import { makeCommitment, parseBidMemo } from "../../auction/src/memo.ts";
import { claimKeyFromBidFile } from "../../relayer/src/client.ts";
import { LATE_BID_MARGIN as SERVER_MARGIN } from "../../relayer/src/phase.ts";

const UA = "utest1" + "q".repeat(200);
const launch = { name: "Ember", launchId: "5", programId: "P", mint: "M", bidAddress: "utest1launch", reservePrice: "100", decimals: 6, endHeight: 4600000, phase: "bidding", blocksLeft: 12, blocksToStart: 0 };

test("ZEC amounts parse exactly, to the zatoshi", () => {
  assert.equal(parseZec("0.0004"), 40000n);
  assert.equal(parseZec("1"), 100000000n);
  assert.equal(parseZec(".5"), 50000000n);
  assert.equal(parseZec("0.00000001"), 1n);
  for (const bad of ["", ".", "1.123456789", "-1", "1e3", "abc", "1,5"]) assert.equal(parseZec(bad), null, bad);
  assert.equal(formatZec(40000n), "0.0004");
  assert.equal(formatZec(100000000n), "1");
});

test("a bid is checked against the launch's terms", () => {
  const ok = checkBid({ price: "0.000004", amount: "0.002", refundTo: ` ${UA} ` }, launch);
  assert.equal(ok.maxPrice, 400n);
  assert.equal(ok.amountZats, 200000n);
  assert.equal(ok.refundTo, UA);
  assert.equal(ok.tokensAtMax, 500000000n, "0.002 ZEC at 0.000004 ZEC each is 500 whole tokens");
  assert.match(checkBid({ price: "0.0000001", amount: "1", refundTo: UA }, launch).problem, /reserve price is 0.000001/);
  assert.match(checkBid({ price: "0.000004", amount: "", refundTo: UA }, launch).problem, /how much ZEC/);
  assert.match(checkBid({ price: "0.000004", amount: "1", refundTo: "" }, launch).problem, /refund address is needed/);
  assert.match(checkBid({ price: "0.000004", amount: "1", refundTo: "t1mainnetaddr" }, launch).problem, /testnet/);
  assert.match(checkBid({ price: "1", amount: "0.00000001", refundTo: UA }, { ...launch, decimals: 0 }).problem, /does not buy any tokens/);
});

test("the browser bid matches the command-line format, and claim.ts can use its file", async () => {
  const key = await makeClaimKey();
  const commitment = makeCommitment(Buffer.from(key.claimPubkey, "hex"), Buffer.from(key.salt, "hex"));
  assert.equal(key.commitment, commitment, "same commitment as auction/src/memo.ts");

  const bid = checkBid({ price: "0.000004", amount: "0.002", refundTo: UA }, launch);
  const memo = bidMemo({ commitment: key.commitment, ...bid });
  assert.deepEqual(parseBidMemo(memo), { commitment: key.commitment, maxPrice: 400n, refundTo: UA });

  const dir = mkdtempSync(join(tmpdir(), "sc-bid-"));
  const path = join(dir, "bid.json");
  writeFileSync(path, JSON.stringify(bidFile(key, launch, bid, memo)));
  const loaded = claimKeyFromBidFile(path);
  assert.equal(loaded.keypair.publicKey.toBuffer().toString("hex"), key.claimPubkey);
  assert.equal(loaded.commitment, key.commitment);
});

test("the payment request carries address, amount and memo (ZIP 321)", () => {
  const uri = paymentUri("utest1launch", 200000n, "SC1 BID c=ab p=400");
  const url = new URL(uri);
  assert.equal(url.protocol, "zcash:");
  assert.equal(url.pathname, "utest1launch");
  assert.equal(url.searchParams.get("amount"), "0.002");
  assert.equal(Buffer.from(url.searchParams.get("memo"), "base64url").toString("utf8"), "SC1 BID c=ab p=400");
  assert.doesNotMatch(url.searchParams.get("memo"), /[+/=]/, "base64url without padding");
});

test("memos longer than Zcash allows are refused", () => {
  assert.throws(() => bidMemo({ commitment: "a".repeat(64), maxPrice: 1n, refundTo: "utest1" + "q".repeat(500) }), /Zcash memos hold 512/);
});

test("bidders are warned when the window is nearly closed", () => {
  assert.equal(LATE_BID_MARGIN, SERVER_MARGIN, "same margin as the server");
  assert.equal(timing(launch).late, false);
  const late = timing({ ...launch, blocksLeft: LATE_BID_MARGIN - 1 });
  assert.match(timing({ ...launch, blocksLeft: 1 }).note, /Only 1 block left/);
  assert.equal(late.late, true);
  assert.match(late.note, /refunded, not counted/);
  assert.equal(timing({ ...launch, phase: "lot", blocksToStart: 6 }).open, false);
  assert.equal(timing({ ...launch, phase: "settling" }).open, false);
});
