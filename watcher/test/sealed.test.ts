import { test } from "node:test";
import assert from "node:assert/strict";
import { sealBid } from "../../web/src/seal.js";
import { scanBids, type ReceivedOutput } from "../src/bids.ts";
import { settle } from "../src/settle.ts";
import { audit } from "../src/audit.ts";
import { unseal } from "../src/sealed.ts";

// A real drand quicknet beacon (see web/test/seal.test.js).
const ROUND = 30000000;
const SIG = "81d2fc112b91932d9e4074a46b88c4dc78149b859660e0673c0bb9bd0caefdc9cc194e83de980441355b8ef44cc7a355";
const SEAL = { round: ROUND, revealAt: 1_800_000_000 };
const C = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const params = { supply: 2_000_000_000n, decimals: 6, reservePrice: 100n };
const window = { startHeight: 100, endHeight: 120 };

async function sealedOutput(i: number, bid: { maxPrice: bigint; refundTo?: string }, value: bigint, opts: { round?: number; height?: number; time?: number } = {}): Promise<ReceivedOutput> {
  const memoBytes = await sealBid({ commitment: C(i), ...bid }, opts.round ?? ROUND);
  return { txid: `t${i}`, outputIndex: 0, minedHeight: opts.height ?? 110, minedTime: opts.time ?? SEAL.revealAt - 600, valueZats: value, memo: null, memoBytes };
}

test("sealed bids open into ordinary bids and settle like plain ones", async () => {
  const outputs = [
    await sealedOutput(1, { maxPrice: 500n, refundTo: "utest1a" }, 300_000n),
    await sealedOutput(2, { maxPrice: 400n, refundTo: "utest1b" }, 200_000n),
    await sealedOutput(3, { maxPrice: 300n, refundTo: "utest1c" }, 200_000n),
    await sealedOutput(4, { maxPrice: 200n, refundTo: "utest1d" }, 100_000n),
  ];
  const scan = scanBids(await unseal(outputs, SEAL, SIG), { ...window, sealedUntil: SEAL.revealAt });
  assert.equal(scan.bids.length, 4);
  assert.deepEqual(scan.bids.map((b) => b.maxPrice), [500n, 400n, 300n, 200n]);
  const s = settle(scan.bids, params);
  assert.deepEqual(s.price, { num: 300n, den: 1n }, "the price competition sets");
  assert.deepEqual(s.outcomes.map((o) => o.refundZats), [0n, 0n, 99_999n, 100_000n], "marginal bid partly filled, losing bid refunded");
  assert.deepEqual(s.outcomes.map((o) => o.refundTo), ["utest1a", "utest1b", "utest1c", "utest1d"]);
});

test("a sealed bid to another round, or tampered with, carries no readable bid", async () => {
  const wrongRound = await sealedOutput(1, { maxPrice: 500n, refundTo: "utest1a" }, 1_000n, { round: ROUND + 1 });
  const tampered = await sealedOutput(2, { maxPrice: 500n, refundTo: "utest1b" }, 1_000n);
  tampered.memoBytes![200] ^= 1;
  const opened = await unseal([wrongRound, tampered], SEAL, SIG);
  assert.deepEqual(opened.map((o) => o.memo), [null, null]);
  const scan = scanBids(opened, { ...window, sealedUntil: SEAL.revealAt });
  assert.deepEqual(scan.rejected.map((r) => r.reason), ["no bid memo", "no bid memo"]);
});

test("a bid mined once the seal could be opened is late, and refunded as late", async () => {
  const onTime = await sealedOutput(1, { maxPrice: 500n, refundTo: "utest1a" }, 1_000n, { time: SEAL.revealAt - 1 });
  const afterSeal = await sealedOutput(2, { maxPrice: 900n, refundTo: "utest1b" }, 1_000n, { time: SEAL.revealAt });
  const scan = scanBids(await unseal([onTime, afterSeal], SEAL, SIG), { ...window, sealedUntil: SEAL.revealAt });
  assert.equal(scan.bids.length, 1);
  assert.deepEqual(scan.rejected, [{ id: "t2:0", valueZats: 1_000n, reason: "outside window", refundTo: "utest1b", maxPrice: 900n }]);
});

test("without a block time a sealed launch refuses to guess", async () => {
  const [o] = await unseal([{ ...(await sealedOutput(1, { maxPrice: 500n }, 1_000n)), minedTime: null }], SEAL, SIG);
  assert.ok(o.memo, "the bid opened");
  assert.throws(() => scanBids([o], { ...window, sealedUntil: SEAL.revealAt }), /no block time/);
});

test("the audit re-runs a sealed launch from the opened bids and matches the root", async () => {
  const outputs = await unseal([
    await sealedOutput(1, { maxPrice: 500n, refundTo: "utest1a" }, 300_000n),
    await sealedOutput(2, { maxPrice: 200n, refundTo: "utest1b" }, 100_000n),
  ], SEAL, SIG);
  const sealedWindow = { ...window, sealedUntil: SEAL.revealAt };
  const published = settle(scanBids(outputs, sealedWindow).bids, params).root;
  const report = audit({ received: outputs, sent: [], window: sealedWindow, params, publishedRoot: published });
  assert.equal(report.rootMatches, true);
  assert.equal(report.bids, 2);
});

test("the audit lists every opened bid, highest price first, with late bids marked", async () => {
  const outputs = await unseal([
    await sealedOutput(1, { maxPrice: 300n, refundTo: "utest1c" }, 200_000n),
    await sealedOutput(2, { maxPrice: 500n, refundTo: "utest1a" }, 300_000n),
    await sealedOutput(3, { maxPrice: 400n, refundTo: "utest1b" }, 200_000n),
    await sealedOutput(4, { maxPrice: 200n, refundTo: "utest1d" }, 100_000n),
    await sealedOutput(5, { maxPrice: 600n, refundTo: "utest1e" }, 100_000n, { height: 121 }),
  ], SEAL, SIG);
  const report = audit({ received: outputs, sent: [], window: { ...window, sealedUntil: SEAL.revealAt }, params, publishedRoot: null });
  assert.deepEqual(report.envelopes.map((e) => [e.maxPrice, e.late]), [[600n, true], [500n, false], [400n, false], [300n, false], [200n, false]]);
  assert.deepEqual(report.envelopes.map((e) => e.refundZats), [100_000n, 0n, 0n, 99_999n, 100_000n]);
  assert.equal(JSON.stringify(report.envelopes, (_, x) => (typeof x === "bigint" ? x.toString() : x)).includes("utest1"), false, "no addresses");
});
