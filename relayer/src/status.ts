// The public status of each launch, as served to the city at /api/launches.
// Built only from public sources: the launch's terms, the Zcash chain height,
// the settlement (published once the launch closes) and the Solana account.

import type { LaunchState } from "./client.ts";
import type { PublicTerms } from "./launch-file.ts";
import { blocksLeft, phaseOf, type Phase } from "./phase.ts";

export interface SettlementSummary {
  price: { num: string; den: string } | null;
  tokensSold: string;
  raisedZats: string;
  bids: number;
}

export interface LaunchStatus extends PublicTerms {
  phase: Phase;
  zcashTip: number;
  blocksLeft: number;
  blocksToStart: number;
  result: SettlementSummary | null; // only once the launch is final on Solana
  solana: {
    finalized: boolean;
    noSale: boolean;
    allocated: string;
    claimed: string;
  } | null;
}

export function launchStatus(
  terms: PublicTerms,
  zcashTip: number,
  onChain: LaunchState | null,
  settlement: SettlementSummary | null,
): LaunchStatus {
  const input = {
    zcashTip,
    startHeight: terms.startHeight,
    endHeight: terms.endHeight,
    finalized: onChain?.finalized ?? false,
    noSale: onChain?.noSale ?? false,
  };
  const phase = phaseOf(input);
  return {
    ...terms,
    phase,
    zcashTip,
    blocksLeft: blocksLeft(input),
    blocksToStart: Math.max(0, terms.startHeight - zcashTip),
    // The result is shown only once it is final on Solana, so the city never
    // shows a number the chain has not committed to.
    result: phase === "live" || phase === "no sale" ? settlement : null,
    solana: onChain && {
      finalized: onChain.finalized,
      noSale: onChain.noSale,
      allocated: onChain.allocated.toString(),
      claimed: onChain.claimed.toString(),
    },
  };
}
