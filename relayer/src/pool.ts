// Sizing the trading pool a launch opens with. The pool starts at the auction's
// clearing price: its SOL side is the ZEC raised, priced in SOL by a live NEAR
// Intents quote, and its token side is what that ZEC bought at the clearing
// price. So the first trade happens at the price every bidder paid.

import type { Price } from "../../auction/src/clearing.ts";

export interface PoolRecord {
  id: string; // Raydium CPMM pool address
  lpMint: string;
  tokens: string; // base units put in
  lamports: string; // SOL put in
  createTx: string;
  burnTx: string; // the LP tokens were burned, so nobody can pull the liquidity
}

// Token base units the raised ZEC buys at the clearing price (price is
// zatoshis per whole token, as a fraction).
export function poolTokens(raisedZats: bigint, price: Price, decimals: number): bigint {
  return (raisedZats * 10n ** BigInt(decimals) * BigInt(price.den)) / BigInt(price.num);
}

// "0.022856557" SOL -> 22856557n lamports, exactly. SOL has 9 decimals.
export function lamportsOf(sol: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9})\d*)?$/.exec(sol.trim());
  if (!m) throw new Error(`not a SOL amount: ${sol}`);
  return BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
}
