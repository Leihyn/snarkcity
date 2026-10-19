// Turns a settlement into shielded payments back to bidders. Each bid that
// named a refund address gets one payment: its refund (zero for a winner who
// spent everything) with a receipt in the memo. Late bids are refunded in full.
//
// Receipt memo:  SC1 RCPT bid=<txid>:<output> tok=<tokens> px=<num>/<den> refund=<zats>
//
// Re-running is safe: bids that already have a receipt in the wallet's sent
// outputs (mined or pending) are skipped.

import type { Price } from "../../auction/src/clearing.ts";
import { assertMemoFits } from "../../auction/src/memo.ts";
import type { Rejected, SentOutput } from "./bids.ts";
import type { BidOutcome } from "./settle.ts";

export interface Payout {
  bidId: string;
  to: string;
  zats: bigint;
  memo: string;
}

export interface PayoutPlan {
  payouts: Payout[];
  alreadyPaid: string[];
  noAddress: { bidId: string; owedZats: bigint }[]; // owed money but gave no refund address
}

const RECEIPT_RE = /^SC1 RCPT bid=([0-9a-f]{64}:\d+) /;

export function receiptMemo(bidId: string, tokens: bigint, price: Price | null, refund: bigint): string {
  const px = price ? `${price.num}/${price.den}` : "none";
  return assertMemoFits(`SC1 RCPT bid=${bidId} tok=${tokens} px=${px} refund=${refund}`);
}

export function receiptMemoBidId(memo: string): string | null {
  return RECEIPT_RE.exec(memo)?.[1] ?? null;
}

export function receiptedBids(sent: SentOutput[]): Set<string> {
  const ids = new Set<string>();
  for (const s of sent) {
    const id = s.memo ? receiptMemoBidId(s.memo) : null;
    if (id) ids.add(id);
  }
  return ids;
}

// Every bid's outcome: settled bids, plus bids mined outside the window, which
// are refunded in full. Unmined payments are left alone; they may still land
// inside the window.
export function withLateBids(settled: BidOutcome[], rejected: Rejected[]): BidOutcome[] {
  const late = rejected
    .filter((r) => r.reason === "outside window")
    .map((r) => ({ bidId: r.id, refundTo: r.refundTo ?? null, tokens: 0n, refundZats: r.valueZats }));
  return [...settled, ...late];
}

export function planPayouts(all: BidOutcome[], price: Price | null, sent: SentOutput[]): PayoutPlan {
  const done = receiptedBids(sent);
  const plan: PayoutPlan = { payouts: [], alreadyPaid: [], noAddress: [] };
  for (const o of all) {
    if (done.has(o.bidId)) { plan.alreadyPaid.push(o.bidId); continue; }
    if (!o.refundTo) {
      if (o.refundZats > 0n) plan.noAddress.push({ bidId: o.bidId, owedZats: o.refundZats });
      continue;
    }
    const px = o.tokens > 0n ? price : null;
    plan.payouts.push({ bidId: o.bidId, to: o.refundTo, zats: o.refundZats, memo: receiptMemo(o.bidId, o.tokens, px, o.refundZats) });
  }
  return plan;
}

// ZIP 321 payment request with one entry per payout. Amounts are decimal ZEC;
// memos are base64url without padding.
export function toPaymentUri(payouts: Payout[]): string {
  const params = payouts.flatMap((p, i) => {
    const sfx = i === 0 ? "" : `.${i}`;
    return [
      `address${sfx}=${p.to}`,
      `amount${sfx}=${zatsToZec(p.zats)}`,
      `memo${sfx}=${Buffer.from(p.memo, "utf8").toString("base64url")}`,
    ];
  });
  return `zcash:?${params.join("&")}`;
}

export function zatsToZec(zats: bigint): string {
  const whole = zats / 100_000_000n;
  const frac = (zats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ZIP 317 fee: 5,000 zatoshis per logical action, at least 2. A conservative
// upper estimate per batch: one action per output, plus change, plus up to as
// many spends as outputs.
export function feeEstimateZats(batchSizes: number[]): bigint {
  return batchSizes.reduce((sum, n) => sum + 5_000n * BigInt(Math.max(2, 2 * n + 1)), 0n);
}

export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
