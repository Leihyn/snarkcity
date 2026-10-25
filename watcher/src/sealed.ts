// Opens sealed bids (web/src/seal.js) once drand has published the launch's
// round. Each opened bid is rewritten as the plain bid memo format, so the
// auction, settlement, refunds and audit read it like any other bid.

import { formatBidMemo } from "../../auction/src/memo.ts";
import { DRAND, openBid, sealedRound } from "../../web/src/seal.js";
import type { ReceivedOutput } from "./bids.ts";

export interface Seal {
  round: number; // drand round the launch's bids are sealed to
  revealAt: number; // unix time drand publishes it
}

// drand's public HTTP mirrors. The signature is checked by the decryption
// itself (a wrong one fails to open anything), so no mirror has to be trusted.
const MIRRORS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"];

// The round's signature (hex), or null if drand has not published it yet.
export async function drandSignature(round: number): Promise<string | null> {
  let lastError: unknown;
  for (const base of MIRRORS) {
    try {
      const res = await fetch(`${base}/${DRAND.chainHash}/public/${round}`, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 404 || res.status === 425) return null; // not published yet
      if (!res.ok) throw new Error(`${base}: HTTP ${res.status}`);
      const body = (await res.json()) as { round: number; signature: string };
      if (body.round !== round) throw new Error(`${base}: asked for round ${round}, got ${body.round}`);
      return body.signature;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`no drand mirror answered: ${(lastError as Error).message}`);
}

// Rewrites each sealed bid as a plain bid memo. A sealed memo that does not
// open (another round, tampered, malformed) carries no readable bid, so it is
// treated like any payment without a bid memo.
export async function unseal(outputs: ReceivedOutput[], seal: Seal, signature: string): Promise<ReceivedOutput[]> {
  return Promise.all(outputs.map(async (o) => {
    const round = o.memoBytes ? sealedRound(o.memoBytes) : null;
    if (round === null) return o;
    const bid = round === seal.round ? await openBid(o.memoBytes!, signature) : null;
    return { ...o, memo: bid ? formatBidMemo(bid) : null };
  }));
}
