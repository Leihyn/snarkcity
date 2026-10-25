// Independent audit of a launch from its viewing key alone. A watch-only wallet
// sees every payment into the launch wallet and every payment out of it, so the
// auditor can:
//   1. rebuild the bids and re-run the auction,
//   2. check the result against the root the operator published on Solana,
//   3. check that every refund was paid in full to the address the bid named.
//
// Publishing the viewing key reveals bid amounts, memos and refund addresses,
// but not who sent them. Use a fresh wallet per launch, and a fresh refund
// address per bid.

import type { LaunchParams, Price } from "../../auction/src/clearing.ts";
import { scanBids, type ReceivedOutput, type SentOutput, type Window } from "./bids.ts";
import { receiptMemoBidId, withLateBids } from "./payouts.ts";
import { settle } from "./settle.ts";

export interface AuditInput {
  received: ReceivedOutput[];
  sent: SentOutput[];
  window: Window;
  params: LaunchParams;
  publishedRoot: string | null;
  // A watch-only wallet recovers only the receiver a payment went to, not the
  // unified address the sender typed, so "same recipient" means the paid-to
  // receivers all belong to the address the bid named. Defaults to exact match.
  sameRecipient?: (paidTo: string, named: string) => boolean;
}

export type PayoutStatus = "paid" | "pending" | "missing" | "wrong amount" | "wrong address" | "no address";

export interface PayoutCheck {
  bidId: string;
  owedZats: bigint;
  status: PayoutStatus;
  txid?: string;
}

// One bid as the opened auction shows it: what it offered and what it got. No
// addresses or keys, so the page can show every bid after the close.
export interface Envelope {
  maxPrice: bigint;
  amountZats: bigint;
  tokens: bigint;
  refundZats: bigint;
  late: boolean;
}

export interface AuditReport {
  bids: number;
  rejected: number;
  price: Price | null;
  tokensSold: bigint;
  raisedZats: bigint;
  root: string | null;
  rootMatches: boolean;
  payouts: PayoutCheck[];
  envelopes: Envelope[]; // every bid, highest price first
  ok: boolean; // root matches and every owed payout is confirmed (or had no address)
}

export function audit(input: AuditInput): AuditReport {
  const scan = scanBids(input.received, input.window);
  const s = settle(scan.bids, input.params);
  const owed = withLateBids(s.outcomes, scan.rejected).filter((o) => o.refundZats > 0n);
  const same = input.sameRecipient ?? ((a: string, b: string) => a === b);
  const payouts = owed.map((o) => checkPayout(o.bidId, o.refundTo, o.refundZats, input.sent, same));
  const rootMatches = s.root === input.publishedRoot;
  return {
    bids: scan.bids.length,
    rejected: scan.rejected.length,
    price: s.price,
    tokensSold: s.tokensSold,
    raisedZats: s.raisedZats,
    root: s.root,
    rootMatches,
    payouts,
    envelopes: envelopesOf(scan, s.outcomes),
    ok: rootMatches && payouts.every((p) => p.status === "paid" || p.status === "no address"),
  };
}

function envelopesOf(scan: ReturnType<typeof scanBids>, outcomes: { tokens: bigint; refundZats: bigint }[]): Envelope[] {
  const counted = scan.bids.map((b, i) => ({ maxPrice: b.maxPrice, amountZats: b.amountZats, tokens: outcomes[i].tokens, refundZats: outcomes[i].refundZats, late: false }));
  const late = scan.rejected
    .filter((r) => r.reason === "outside window" && r.maxPrice !== undefined)
    .map((r) => ({ maxPrice: r.maxPrice!, amountZats: r.valueZats, tokens: 0n, refundZats: r.valueZats, late: true }));
  return [...counted, ...late].sort((a, b) => (a.maxPrice === b.maxPrice ? 0 : a.maxPrice > b.maxPrice ? -1 : 1));
}

function checkPayout(
  bidId: string,
  refundTo: string | null,
  owedZats: bigint,
  sent: SentOutput[],
  sameRecipient: (paidTo: string, named: string) => boolean,
): PayoutCheck {
  if (!refundTo) return { bidId, owedZats, status: "no address" };
  const out = sent.find((s) => s.memo !== null && receiptMemoBidId(s.memo) === bidId);
  if (!out) return { bidId, owedZats, status: "missing" };
  const base = { bidId, owedZats, txid: out.txid };
  if (out.valueZats !== owedZats) return { ...base, status: "wrong amount" };
  if (!out.toAddress || !sameRecipient(out.toAddress, refundTo)) return { ...base, status: "wrong address" };
  return { ...base, status: out.minedHeight === null ? "pending" : "paid" };
}
