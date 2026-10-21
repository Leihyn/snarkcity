// What the city shows for a launch, decided from public facts only: the
// Zcash chain height, the launch's bidding window, and its state on Solana.
// Nothing here can reveal demand during bidding, because nothing public does.

export type Phase =
  | "lot" // opened, bidding not started: supply locked on Solana
  | "bidding" // window open: the tower is in fog
  | "settling" // window closed, result not yet final on Solana: still fog
  | "no sale" // closed with nothing sold: supply returned
  | "live"; // root posted: allocations claimable

export interface PhaseInput {
  zcashTip: number;
  startHeight: number;
  endHeight: number;
  finalized: boolean; // root posted or closed without sale
  noSale: boolean;
}

export function phaseOf(x: PhaseInput): Phase {
  if (x.finalized) return x.noSale ? "no sale" : "live";
  if (x.zcashTip < x.startHeight) return "lot";
  if (x.zcashTip <= x.endHeight) return "bidding";
  return "settling";
}

// Blocks a new bid still has. A bid can take a few blocks to be mined, so the
// city warns when fewer than this many remain.
export const LATE_BID_MARGIN = 5;

export function blocksLeft(x: PhaseInput): number {
  return Math.max(0, x.endHeight - x.zcashTip);
}
