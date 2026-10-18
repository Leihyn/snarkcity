// Reads incoming payments from a zcash-devtool wallet database and turns the
// ones carrying a valid bid memo into auction bids. The database can be the
// launch wallet itself or a watch-only copy built from its viewing key, which
// is exactly what the public audit does.

import { DatabaseSync } from "node:sqlite";
import { parseBidMemo } from "../../auction/src/memo.ts";
import type { Bid } from "../../auction/src/clearing.ts";

export interface ReceivedOutput {
  txid: string; // display order (as explorers show it)
  outputIndex: number;
  minedHeight: number | null;
  valueZats: bigint;
  memo: string | null;
}

export interface Window {
  startHeight: number; // first block that accepts bids
  endHeight: number; // last block that accepts bids
}

export interface Rejected {
  id: string;
  valueZats: bigint;
  reason: "unmined" | "outside window" | "no bid memo";
  refundTo?: string; // set when the memo is a valid bid, so a late bid can be refunded
}

export interface BidScan {
  bids: (Bid & { minedHeight: number })[];
  rejected: Rejected[];
}

const QUERY = `
  SELECT txid, output_index, tx_mined_height, value, memo
  FROM v_tx_outputs
  WHERE to_account_uuid IS NOT NULL AND is_change = 0`;

export function readReceived(dbPath: string): ReceivedOutput[] {
  return queryRows(dbPath, QUERY).map((r) => ({
    txid: txidOf(r.txid),
    outputIndex: Number(r.output_index),
    minedHeight: heightOf(r.tx_mined_height),
    valueZats: BigInt(numberLike(r.value)),
    memo: decodeMemo(r.memo instanceof Uint8Array ? r.memo : null),
  }));
}

export interface SentOutput {
  txid: string;
  minedHeight: number | null; // null while pending
  toAddress: string | null;
  valueZats: bigint;
  memo: string | null;
}

// Payments this wallet made to other wallets. A watch-only wallet built from a
// full viewing key sees these too, which lets the audit check refunds.
const SENT_QUERY = `
  SELECT txid, tx_mined_height, to_address, value, memo
  FROM v_tx_outputs
  WHERE from_account_uuid IS NOT NULL AND to_account_uuid IS NULL AND is_change = 0`;

export function readSent(dbPath: string): SentOutput[] {
  return queryRows(dbPath, SENT_QUERY).map((r) => ({
    txid: txidOf(r.txid),
    minedHeight: heightOf(r.tx_mined_height),
    toAddress: typeof r.to_address === "string" ? r.to_address : null,
    valueZats: BigInt(numberLike(r.value)),
    memo: decodeMemo(r.memo instanceof Uint8Array ? r.memo : null),
  }));
}

type SqlValue = null | number | bigint | string | Uint8Array;
type Row = Record<string, SqlValue>;

function queryRows(dbPath: string, sql: string): Row[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as Row[];
  } finally {
    db.close();
  }
}

// The wallet DB stores txids in internal byte order; explorers show them reversed.
function txidOf(v: SqlValue): string {
  if (!(v instanceof Uint8Array) || v.length !== 32) throw new Error("txid column is not 32 bytes");
  return Buffer.from(v).reverse().toString("hex");
}

function heightOf(v: SqlValue): number | null {
  return v === null ? null : Number(numberLike(v));
}

function numberLike(v: SqlValue): number | bigint {
  if (typeof v !== "number" && typeof v !== "bigint") throw new Error(`expected a number, got ${typeof v}`);
  return v;
}

// ZIP 302: a first byte up to 0xF4 means UTF-8 text; anything else is not a text memo.
export function decodeMemo(bytes: Uint8Array | null): string | null {
  if (!bytes || bytes.length === 0 || bytes[0] > 0xf4) return null;
  return Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");
}

export function scanBids(outputs: ReceivedOutput[], window: Window): BidScan {
  const scan: BidScan = { bids: [], rejected: [] };
  for (const o of outputs) {
    const id = `${o.txid}:${o.outputIndex}`;
    const memo = o.memo === null ? null : parseBidMemo(o.memo);
    const reject = (reason: Rejected["reason"]) =>
      scan.rejected.push({ id, valueZats: o.valueZats, reason, ...(memo?.refundTo && { refundTo: memo.refundTo }) });
    if (o.minedHeight === null) { reject("unmined"); continue; }
    if (o.minedHeight < window.startHeight || o.minedHeight > window.endHeight) { reject("outside window"); continue; }
    if (!memo) { reject("no bid memo"); continue; }
    scan.bids.push({ txid: id, amountZats: o.valueZats, minedHeight: o.minedHeight, ...memo });
  }
  return scan;
}
