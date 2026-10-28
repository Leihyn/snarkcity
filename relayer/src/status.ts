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

// One launch in the city's index (/api/city): enough to draw its building and
// list it, a few hundred bytes, so the index stays small with thousands of
// launches. The full status is at /api/launch/<id>.
export interface CityEntry {
  id: string; // launchId: a creation time in ms, so it sorts by age
  name: string;
  kind: PublicTerms["kind"];
  phase: Phase;
  sold: number; // share of supply sold, 0..1; 0 unless live
  lit: number; // claimed / allocated, 0..1; 0 if nothing allocated
  endHeight: number;
  blocksLeft: number;
  blocksToStart: number;
  raisedZats: string; // "0" until a final result raised something
  sealed: boolean;
  frost: boolean;
  deposit: boolean;
}

// part / whole rounded to 3 decimals and capped at 1, in bigint so a large
// supply does not lose precision before the division.
function share(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const milli = (part * 1000n + whole / 2n) / whole;
  return Math.min(1000, Number(milli)) / 1000;
}

export function cityEntry(s: LaunchStatus): CityEntry {
  return {
    id: s.launchId,
    name: s.name,
    kind: s.kind,
    phase: s.phase,
    sold: s.phase === "live" && s.result ? share(BigInt(s.result.tokensSold), BigInt(s.supply)) : 0,
    lit: s.solana ? share(BigInt(s.solana.claimed), BigInt(s.solana.allocated)) : 0,
    endHeight: s.endHeight,
    blocksLeft: s.blocksLeft,
    blocksToStart: s.blocksToStart,
    raisedZats: s.result?.raisedZats ?? "0",
    sealed: Boolean(s.seal),
    frost: s.custody?.kind === "frost",
    deposit: Boolean(s.deposit),
  };
}
