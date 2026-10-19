// The operator's launch file (private: wallet paths, keys) and the public
// terms derived from it, which the city and any auditor read.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export interface LaunchFile {
  name: string;
  kind: "memecoin" | "startup";
  zcash: {
    devtool: string;
    walletDir: string; // a fresh wallet for this launch only
    identity: string;
    biddingBlocks: number; // how long bidding stays open
    address?: string; // filled by open-launch: where bids are sent
    startHeight?: number;
    endHeight?: number;
  };
  sale: { supply: string; decimals: number; reservePrice: string };
  solana: {
    rpc: string;
    keypair: string; // creator and relayer for the demo
    mint?: string; // filled by open-launch (a test mint is created if absent)
    creator?: string;
    launchId?: string;
  };
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
  programId: string;
  rpc: string;
  mint: string;
  creator: string;
  launchId: string;
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
  return { name: l.name, kind: l.kind, bidAddress: address, startHeight, endHeight, ...l.sale, programId, rpc: l.solana.rpc, mint, creator, launchId };
}

export const expandHome = (p: string) => p.replace(/^~(?=\/)/, homedir());
