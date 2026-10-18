import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReceivedOutput, SentOutput } from "../src/bids.ts";
import { batches, planPayouts, receiptMemo, toPaymentUri, withLateBids, zatsToZec } from "../src/payouts.ts";
import { settle } from "../src/settle.ts";
import { audit, type AuditInput } from "../src/audit.ts";
import { formatBidMemo } from "../../auction/src/memo.ts";

const tx = (c: string) => c.repeat(64);
const C1 = "11".repeat(32);
const C2 = "22".repeat(32);
const params = { supply: 100n, decimals: 0, reservePrice: 1n };
const window = { startHeight: 100, endHeight: 200 };

// The auction's oversubscribed case, as payments the launch wallet received:
// a wins 75 tokens and spends everything; b wins 25 and gets 100 back;
// c is below the price and gets all 400 back; d arrived after the window.
const received: ReceivedOutput[] = [
  { txid: tx("a"), outputIndex: 0, minedHeight: 150, valueZats: 600n, memo: `SC1 BID c=${C1} p=10 r=ua` },
  { txid: tx("b"), outputIndex: 0, minedHeight: 151, valueZats: 300n, memo: `SC1 BID c=${C2} p=8 r=ub` },
  { txid: tx("c"), outputIndex: 0, minedHeight: 152, valueZats: 400n, memo: `SC1 BID c=${"33".repeat(32)} p=5 r=uc` },
  { txid: tx("d"), outputIndex: 0, minedHeight: 250, valueZats: 50n, memo: `SC1 BID c=${"44".repeat(32)} p=9 r=ud` },
];

function plan(sent: SentOutput[] = []) {
  const s = settle(
    received.slice(0, 3).map((r) => ({ txid: `${r.txid}:0`, amountZats: r.valueZats, ...parse(r.memo!) })),
    params,
  );
  const late = [{ id: `${tx("d")}:0`, valueZats: 50n, reason: "outside window" as const, refundTo: "ud" }];
  return { s, plan: planPayouts(withLateBids(s.outcomes, late), s.price, sent) };
}

function parse(memo: string) {
  const [, c, p, r] = /c=(\w+) p=(\d+) r=(\w+)/.exec(memo)!;
  return { commitment: c, maxPrice: BigInt(p), refundTo: r };
}

test("every bid with an address gets one payout: refund plus receipt, late bids in full", () => {
  const { plan: p } = plan();
  assert.deepEqual(p.payouts.map((x) => [x.to, x.zats]), [["ua", 0n], ["ub", 100n], ["uc", 400n], ["ud", 50n]]);
  assert.equal(p.payouts[1].memo, `SC1 RCPT bid=${tx("b")}:0 tok=25 px=8/1 refund=100`);
  assert.equal(p.payouts[2].memo, `SC1 RCPT bid=${tx("c")}:0 tok=0 px=none refund=400`);
});

test("worst-case memos fit in 512 bytes, and oversize ones are refused", () => {
  // Largest plausible values: u64 tokens, a 34-digit price numerator over a u64 supply, all ZEC refunded.
  const price = { num: 10n ** 33n * 21n, den: (1n << 64n) - 1n };
  const memo = receiptMemo(`${tx("f")}:65535`, (1n << 64n) - 1n, price, 21_000_000n * 100_000_000n);
  assert.ok(Buffer.byteLength(memo) <= 512, `receipt is ${Buffer.byteLength(memo)} bytes`);
  const bid = formatBidMemo({ commitment: C1, maxPrice: 10n ** 18n, refundTo: "u".repeat(400) });
  assert.ok(Buffer.byteLength(bid) <= 512, `bid is ${Buffer.byteLength(bid)} bytes`);
  assert.throws(() => formatBidMemo({ commitment: C1, maxPrice: 1n, refundTo: "u".repeat(500) }), /512/);
});

test("re-running skips bids that already have a receipt, mined or pending", () => {
  const sent: SentOutput[] = [
    { txid: tx("e"), minedHeight: null, toAddress: "ub", valueZats: 100n, memo: receiptMemo(`${tx("b")}:0`, 25n, null, 100n) },
  ];
  const { plan: p } = plan(sent);
  assert.deepEqual(p.alreadyPaid, [`${tx("b")}:0`]);
  assert.equal(p.payouts.length, 3);
});

test("payment request follows ZIP 321: indexed params, decimal ZEC, base64url memos", () => {
  const uri = toPaymentUri([
    { bidId: "x", to: "ua", zats: 150_000_000n, memo: "hi?" },
    { bidId: "y", to: "ub", zats: 1n, memo: "ok" },
  ]);
  assert.equal(uri, "zcash:?address=ua&amount=1.5&memo=aGk_&address.1=ub&amount.1=0.00000001&memo.1=b2s");
  assert.equal(zatsToZec(0n), "0");
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

function auditInput(sent: SentOutput[], publishedRoot: string | null): AuditInput {
  return { received, sent, window, params, publishedRoot };
}

function paidAll(): SentOutput[] {
  return plan().plan.payouts
    .filter((p) => p.zats > 0n)
    .map((p, i) => ({ txid: tx(String(i)), minedHeight: 300, toAddress: p.to, valueZats: p.zats, memo: p.memo }));
}

test("audit passes when the root matches and every refund is paid", () => {
  const r = audit(auditInput(paidAll(), plan().s.root));
  assert.equal(r.rootMatches, true);
  assert.deepEqual(r.payouts.map((p) => p.status), ["paid", "paid", "paid"]);
  assert.equal(r.ok, true);
});

test("audit catches a wrong root, a missing refund, a short refund and a wrong address", () => {
  const sent = paidAll();
  assert.equal(audit(auditInput(sent, "00".repeat(32))).ok, false);
  const root = plan().s.root;
  const statuses = (s: SentOutput[]) => audit(auditInput(s, root)).payouts.map((p) => p.status);
  assert.deepEqual(statuses(sent.slice(1)), ["missing", "paid", "paid"]);
  assert.deepEqual(statuses([{ ...sent[0], valueZats: 99n }, ...sent.slice(1)]), ["wrong amount", "paid", "paid"]);
  assert.deepEqual(statuses([{ ...sent[0], toAddress: "evil" }, ...sent.slice(1)]), ["wrong address", "paid", "paid"]);
  assert.deepEqual(statuses([{ ...sent[0], minedHeight: null }, ...sent.slice(1)]), ["pending", "paid", "paid"]);
});

test("a refund paid to one receiver of the named unified address counts as paid", () => {
  // The watch-only wallet sees only the receiver used ("ub-orchard"), not the bundle the bid named ("ub").
  const sent = paidAll().map((s) => (s.toAddress === "ub" ? { ...s, toAddress: "ub-orchard" } : s));
  const bundles: Record<string, string[]> = { ub: ["ub-orchard", "ub-sapling"], "ub-orchard": ["ub-orchard"] };
  const sameRecipient = (paidTo: string, named: string) =>
    (bundles[paidTo] ?? [paidTo]).every((r) => (bundles[named] ?? [named]).includes(r));
  const r = audit({ ...auditInput(sent, plan().s.root), sameRecipient });
  assert.deepEqual(r.payouts.map((p) => p.status), ["paid", "paid", "paid"]);
  assert.equal(audit(auditInput(sent, plan().s.root)).payouts[0].status, "wrong address", "exact match still rejects it");
});
