import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expired, type SentOutput } from "../src/bids.ts";
import { chainTip, initWatchOnly, isTransient, retryPolicy, withRetry } from "../src/devtool.ts";
import { payBatch, type PayDeps } from "../src/pay-batch.ts";
import { receiptedBids, receiptMemo, type Payout } from "../src/payouts.ts";

retryPolicy.delayMs = 1; // keep the tests fast

const transient = Object.assign(new Error("Command failed"), { stderr: "transport error: peer closed connection without sending TLS close_notify" });
const fatal = Object.assign(new Error("Command failed"), { stderr: "Error: Insufficient balance (have 0, need 110000 including fee)" });

test("server drops and our own time limit count as transient; real errors do not", () => {
  for (const msg of ["deadline has elapsed", "GoAway", "peer closed connection without sending TLS close_notify", "status: Unavailable"]) {
    assert.ok(isTransient({ message: "x", stderr: msg }), msg);
  }
  assert.ok(isTransient({ killed: true, message: "Command failed" }), "killed by the timeout");
  assert.ok(!isTransient(fatal));
  assert.ok(!isTransient({ message: "Error: No such file or directory (os error 2)" }));
});

test("withRetry retries transient failures and gives up on real errors at once", async () => {
  let calls = 0;
  assert.equal(await withRetry(async () => (++calls < 3 ? Promise.reject(transient) : "ok")), "ok");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw fatal; }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw transient; }));
  assert.equal(calls, retryPolicy.attempts);
});

// A stand-in zcash-devtool: fails the first call with a dropped connection,
// then answers like the real `wallet balance`. Counts its calls in a file.
function fakeDevtool(script: string): { bin: string; count: () => number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sc-fake-"));
  const bin = join(dir, "zcash-devtool");
  writeFileSync(bin, `#!/bin/sh\nC="${dir}/calls"; N=$(( $(cat "$C" 2>/dev/null || echo 0) + 1 )); echo $N > "$C"\n${script}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir, count: () => Number(readFileSync(join(dir, "calls"), "utf8")) };
}

test("a dropped connection on a read is retried through the real wrapper", async () => {
  const fake = fakeDevtool(`[ $N -eq 1 ] && { echo "transport error: peer closed connection" >&2; exit 1; }\necho "chain_tip_height: BlockHeight(\n 4519000,\n)"`);
  assert.equal(await chainTip({ bin: fake.bin, dir: fake.dir }), 4519000);
  assert.equal(fake.count(), 2);
});

test("a failed watch-only init is cleaned up before the retry", async () => {
  const fake = fakeDevtool(
    `W="$3"\n[ -e "$W" ] && { echo "wallet already exists" >&2; exit 1; }\nmkdir -p "$W"\n[ $N -eq 1 ] && { echo "GoAway" >&2; exit 1; }\nexit 0`,
  );
  const dir = join(fake.dir, "watch");
  await initWatchOnly({ bin: fake.bin, dir }, "uviewtest1fake", 100);
  assert.equal(fake.count(), 2, "retried once");
  assert.ok(existsSync(dir), "second attempt created it");
});

const bidId = "ab".repeat(32) + ":0";
const receipt = (over: Partial<SentOutput>): SentOutput => ({
  txid: "cd".repeat(32), minedHeight: null, expiryHeight: 140, toAddress: "u", valueZats: 5n,
  memo: receiptMemo(bidId, 0n, null, 5n), ...over,
});

test("a never-mined receipt counts until its expiry height, then not", () => {
  assert.ok(!expired(receipt({}), 139));
  assert.ok(expired(receipt({}), 140));
  assert.ok(!expired(receipt({ minedHeight: 120 }), 500), "mined never expires");
  assert.ok(!expired(receipt({ expiryHeight: 0 }), 500), "0 means no expiry");
  assert.ok(receiptedBids([receipt({})], 139).has(bidId));
  assert.ok(!receiptedBids([receipt({})], 140).has(bidId));
});

const batch: Payout[] = [{ bidId, to: "u", zats: 5n, memo: receiptMemo(bidId, 0n, null, 5n) }];

function deps(payResults: (string | Error)[], sentAfterFailure: SentOutput[], tip = 130): PayDeps & { payCalls: () => number } {
  let calls = 0;
  return {
    pay: async () => { const r = payResults[calls++]; if (r instanceof Error) throw r; return r; },
    refresh: async () => {},
    chainTip: async () => tip,
    readSent: () => sentAfterFailure,
    payCalls: () => calls,
  };
}

test("payBatch: a dropped connection after the wallet recorded the payout is never retried", async () => {
  const d = deps([transient], [receipt({})]);
  assert.deepEqual(await payBatch(batch, d), { status: "in flight" });
  assert.equal(d.payCalls(), 1, "no second payment");
});

test("payBatch: a dropped connection before anything was recorded is retried once", async () => {
  const d = deps([transient, "ee".repeat(32)], []);
  assert.deepEqual(await payBatch(batch, d), { status: "paid", txid: "ee".repeat(32) });
  assert.equal(d.payCalls(), 2);
});

test("payBatch: a recorded payout that expired unmined is paid again", async () => {
  const d = deps([transient, "ff".repeat(32)], [receipt({})], 141);
  assert.deepEqual(await payBatch(batch, d), { status: "paid", txid: "ff".repeat(32) });
});

test("payBatch: real errors are raised, and a second drop is reported, not retried again", async () => {
  await assert.rejects(payBatch(batch, deps([fatal], [])), /Command failed/);
  const d = deps([transient, transient], []);
  assert.equal((await payBatch(batch, d)).status, "failed");
  assert.equal(d.payCalls(), 2);
});
