import { test } from "node:test";
import assert from "node:assert/strict";
import { auditCommand, auditRows, verdict } from "../src/audit-view.js";

// Shaped like relayer/src/audit-launch.ts output after JSON (bigints as strings).
const good = {
  bids: 1, rejected: 0, price: { num: "100", den: "1" }, tokensSold: "4000000000", raisedZats: "400000", root: "ab", rootMatches: true,
  payouts: [{ bidId: "t:1", owedZats: "1000", status: "paid" }],
  onChain: { finalized: true, allocatedMatches: true, supplyMatches: true },
  ok: true,
};

test("a clean audit says the result checks out", () => {
  assert.deepEqual(verdict(good).ok, true);
  assert.match(verdict(good).text, /checks out/);
});

test("a failed audit names every reason", () => {
  const bad = {
    ...good, ok: false, rootMatches: false,
    payouts: [{ status: "paid" }, { status: "missing" }, { status: "wrong amount" }, { status: "no address" }],
    onChain: { finalized: true, allocatedMatches: false, supplyMatches: true },
  };
  const v = verdict(bad);
  assert.equal(v.ok, false);
  assert.match(v.text, /allocation on Solana differs/);
  assert.match(v.text, /tokens allocated on Solana differ/);
  assert.match(v.text, /2 refunds are not paid in full \(missing, wrong amount\)/);
  assert.doesNotMatch(v.text, /token or supply/);
  assert.match(verdict({ ...good, ok: false, onChain: { ...good.onChain, finalized: false } }).text, /no result is final/);
  assert.match(verdict({ ...good, ok: false, payouts: [{ status: "pending" }] }).text, /1 refund is not paid in full \(pending\)/);
});

test("the audit rows read as plain numbers", () => {
  const rows = Object.fromEntries(auditRows(good, 6));
  assert.equal(rows["Clearing price"], "0.000001 ZEC / token");
  assert.equal(rows["Tokens sold"], "4,000");
  assert.equal(rows["ZEC raised"], "0.004 ZEC");
  assert.equal(rows["Refunds paid"], "1 of 1");
  assert.equal(Object.fromEntries(auditRows({ ...good, payouts: [] }, 6))["Refunds paid"], "None owed");
  assert.equal(rows["Matches the allocation on Solana"], "Yes");
  assert.equal(Object.fromEntries(auditRows({ ...good, price: null }, 6))["Clearing price"], "None (nothing sold)");
});

test("the run-it-yourself command uses the downloaded file names", () => {
  assert.equal(
    auditCommand({ terms: "hollow.public.json", viewKey: "hollow.viewkey.txt" }),
    "node relayer/scripts/audit-launch.ts hollow.public.json hollow.viewkey.txt ./audit-wallet <path to zcash-devtool>",
  );
});
