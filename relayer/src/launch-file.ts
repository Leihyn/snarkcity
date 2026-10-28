// The operator's launch file (private: wallet paths, keys) and the public
// terms derived from it, which the city and any auditor read.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { FrostCustody } from "../../watcher/src/frost.ts";
import type { PoolRecord } from "./pool.ts";

// Sealed launches: bids are time-locked to a drand round (web/src/seal.js).
export interface SealTerms {
  round: number; // drand quicknet round the bids open at
  revealAt: number; // unix time drand publishes it; bids mined at or after it are late
  chainHash: string; // drand quicknet, pinned in seal.js
}

export interface LaunchFile {
  name: string;
  kind: "memecoin" | "startup";
  sealed?: boolean; // seal bids with drand; on unless set to false before opening
  custody?: FrostCustody; // 2-of-3 FROST key instead of a single spending key (scripts/frost-wallet.ts)
  seal?: SealTerms; // filled by open-launch for sealed launches
  zcash: {
    devtool: string;
    walletDir: string; // a fresh wallet for this launch only
    identity?: string; // age identity that unlocks the wallet's spending key; absent under FROST custody
    biddingBlocks: number; // how long bidding stays open
    address?: string; // filled by open-launch: where bids are sent
    startHeight?: number;
    endHeight?: number;
  };
  sale: { supply: string; decimals: number; reservePrice: string; deposit?: string }; // deposit: zats every bid pays, budget sealed inside
  solana: {
    rpc: string;
    keypair: string; // creator and relayer for the demo
    mint?: string; // filled by open-launch (a test mint is created if absent)
    creator?: string;
    launchId?: string;
    pool?: PoolRecord; // filled by seed-pool after the sale
  };
}

// What the public sees about custody: the threshold, never the share files.
export interface PublicCustody {
  kind: "frost";
  threshold: number;
  holders: number;
}

export interface PublicTerms {
  name: string;
  kind: LaunchFile["kind"];
  bidAddress: string;
  startHeight: number;
  endHeight: number;
  supply: string;
  decimals: number;
  reservePrice: string;
  deposit?: string;
  programId: string;
  rpc: string;
  mint: string;
  creator: string;
  launchId: string;
  pool?: PoolRecord;
  seal?: SealTerms;
  custody?: PublicCustody;
}

// A bid can take several blocks to be mined after it is sent. With a short
// window, a bid sent in time is mined after the window and refunded as late.
export const MIN_BIDDING_BLOCKS = 20;

export function launchProblems(l: LaunchFile): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(l.zcash.biddingBlocks) || l.zcash.biddingBlocks < MIN_BIDDING_BLOCKS) {
    problems.push(`biddingBlocks must be at least ${MIN_BIDDING_BLOCKS} (got ${l.zcash.biddingBlocks})`);
  }
  if (!(BigInt(l.sale.supply) > 0n)) problems.push("supply must be greater than zero");
  if (!(BigInt(l.sale.reservePrice) >= 0n)) problems.push("reservePrice cannot be negative");
  // A budget in a plain memo is readable by the launch wallet, which defeats the point.
  if (l.sale.deposit !== undefined && !(BigInt(l.sale.deposit) > 0n)) problems.push("deposit must be greater than zero");
  if (l.sale.deposit !== undefined && l.sealed === false) problems.push("a fixed deposit needs sealed bids");
  if (!l.zcash.identity && !l.custody) problems.push("the launch wallet needs an identity file or FROST custody to pay refunds");
  return problems;
}

export function readLaunch(path: string): LaunchFile {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n");
}

export function publicTerms(l: LaunchFile, programId: string): PublicTerms {
  const { address, startHeight, endHeight } = l.zcash;
  const { mint, creator, launchId } = l.solana;
  if (!address || startHeight === undefined || endHeight === undefined || !mint || !creator || !launchId) {
    throw new Error("launch is not open yet");
  }
  const custody = l.custody && { kind: l.custody.kind, threshold: l.custody.signers.length, holders: l.custody.shares.length };
  const extra = { ...(l.solana.pool && { pool: l.solana.pool }), ...(l.seal && { seal: l.seal }), ...(custody && { custody }) };
  return { name: l.name, kind: l.kind, bidAddress: address, startHeight, endHeight, ...l.sale, programId, rpc: l.solana.rpc, mint, creator, launchId, ...extra };
}

export const expandHome = (p: string) => p.replace(/^~(?=\/)/, homedir());
