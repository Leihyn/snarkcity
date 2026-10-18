// Closes a launch: runs the auction over the scanned bids and produces what
// the rest of the system needs. The allocation list and its root go to the
// Solana claim program; refunds go back out as shielded Zcash payments.

import { clearAuction, type Bid, type LaunchParams, type Price } from "../../auction/src/clearing.ts";
import { buildLayers, proofFor, rootOf } from "../../auction/src/merkle.ts";

export interface ClaimEntry {
  commitment: string;
  tokens: bigint;
  proof: string[]; // hex, sibling hashes from leaf to root
}

export interface BidOutcome {
  bidId: string;
  refundTo: string | null; // null: the bid carried no refund address
  tokens: bigint;
  refundZats: bigint;
}

export interface Settlement {
  price: Price | null;
  tokensSold: bigint;
  raisedZats: bigint;
  root: string | null; // hex; null when nothing sold
  claims: ClaimEntry[];
  outcomes: BidOutcome[]; // one per bid, in input order
}

export function settle(bids: Bid[], params: LaunchParams): Settlement {
  const result = clearAuction(bids, params);
  const claims = claimsFrom(result.fills);
  return {
    price: result.price,
    tokensSold: result.tokensSold,
    raisedZats: result.raisedZats,
    root: claims.root,
    claims: claims.entries,
    outcomes: result.fills.map((f) => ({
      bidId: f.bid.txid,
      refundTo: f.bid.refundTo ?? null,
      tokens: f.tokens,
      refundZats: f.refundZats,
    })),
  };
}

// One leaf per commitment: a bidder who reused a claim key across bids gets
// their tokens summed, so the claim program never sees duplicate leaves.
// Leaves are sorted by commitment so the root does not depend on bid order.
function claimsFrom(fills: { bid: Bid; tokens: bigint }[]) {
  const totals = new Map<string, bigint>();
  for (const f of fills) {
    if (f.tokens > 0n) totals.set(f.bid.commitment, (totals.get(f.bid.commitment) ?? 0n) + f.tokens);
  }
  const allocs = [...totals].sort(([a], [b]) => (a < b ? -1 : 1)).map(([commitment, tokens]) => ({ commitment, tokens }));
  if (allocs.length === 0) return { root: null, entries: [] };
  const layers = buildLayers(allocs);
  const entries = allocs.map((a, i) => ({ ...a, proof: proofFor(layers, i).map((h) => h.toString("hex")) }));
  return { root: rootOf(layers).toString("hex"), entries };
}
