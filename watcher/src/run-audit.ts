// Runs the viewing-key audit against the live chain: builds (or reuses) a
// watch-only wallet from the launch's viewing key, syncs it, decodes every
// address involved, and checks the auction result and refunds.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseBidMemo } from "../../auction/src/memo.ts";
import type { LaunchParams } from "../../auction/src/clearing.ts";
import { audit, type AuditReport } from "./audit.ts";
import { readReceived, readSent, type Window } from "./bids.ts";
import { initWatchOnly, receivers, refresh } from "./devtool.ts";

export interface AuditRun {
  devtool: string; // zcash-devtool binary
  ufvk: string; // the launch's unified full viewing key
  dir: string; // watch-only wallet directory (created on first run)
  window: Window;
  params: LaunchParams;
  publishedRoot: string | null;
}

export async function runAudit(run: AuditRun): Promise<AuditReport> {
  const wallet = { bin: run.devtool, dir: run.dir };
  if (!existsSync(join(run.dir, "data.sqlite"))) await initWatchOnly(wallet, run.ufvk, run.window.startHeight - 1);
  await refresh(wallet);
  const db = join(run.dir, "data.sqlite");
  const received = readReceived(db);
  const sent = readSent(db);
  const decoded = await decodeAll(run.devtool, received.map((r) => r.memo), sent.map((s) => s.toAddress));
  return audit({
    received,
    sent,
    window: run.window,
    params: run.params,
    publishedRoot: run.publishedRoot,
    sameRecipient: (paidTo, named) => {
      const ofNamed = new Set(decoded.get(named) ?? [named]);
      return (decoded.get(paidTo) ?? [paidTo]).every((r) => ofNamed.has(r));
    },
  });
}

// Decode every address involved once, so the audit itself stays synchronous.
async function decodeAll(devtool: string, memos: (string | null)[], paidTo: (string | null)[]) {
  const addresses = new Set<string>();
  for (const a of paidTo) if (a) addresses.add(a);
  for (const m of memos) {
    const refundTo = m ? parseBidMemo(m)?.refundTo : undefined;
    if (refundTo) addresses.add(refundTo);
  }
  const decoded = new Map<string, string[]>();
  for (const a of addresses) decoded.set(a, await receivers(devtool, a));
  return decoded;
}
