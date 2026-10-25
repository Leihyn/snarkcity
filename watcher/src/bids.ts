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
  memoBytes?: Uint8Array | null; // raw memo, for sealed (binary) bids
  minedTime?: number | null; // unix time of the block it was mined in
}

export interface Window {
  startHeight: number; // first block that accepts bids
  endHeight: number; // last block that accepts bids
  // Sealed launches: once the bids can be opened, later bids could be placed
  // knowing them, so a bid mined in a block at or after this unix time is late.
  sealedUntil?: number;
}

export interface Rejected {
  id: string;
  valueZats: bigint;
  reason: "unmined" | "outside window" | "no bid memo";
  refundTo?: string; // set when the memo is a valid bid, so a late bid can be refunded
  maxPrice?: bigint; // likewise, so the opened bids can be shown in full
}

export interface BidScan {
  bids: (Bid & { minedHeight: number })[];
  rejected: Rejected[];
}

const QUERY = `
  SELECT o.txid, o.output_index, o.tx_mined_height, o.value, o.memo, b.time AS mined_time
  FROM v_tx_outputs o LEFT JOIN blocks b ON b.height = o.tx_mined_height
  WHERE o.to_account_uuid IS NOT NULL AND o.is_change = 0`;

export function readReceived(dbPath: string): ReceivedOutput[] {
  return queryRows(dbPath, QUERY).map((r) => ({
    txid: txidOf(r.txid),
    outputIndex: Number(r.output_index),
    minedHeight: heightOf(r.tx_mined_height),
    valueZats: BigInt(numberLike(r.value)),
    memo: decodeMemo(r.memo instanceof Uint8Array ? r.memo : null),
    memoBytes: r.memo instanceof Uint8Array ? r.memo : null,
    minedTime: heightOf(r.mined_time),
  }));
}

export interface SentOutput {
  txid: string;
  minedHeight: number | null; // null while pending
  expiryHeight?: number | null; // last block it can be mined in; null or 0: never expires
  toAddress: string | null;
  valueZats: bigint;
  memo: string | null;
}

// Payments this wallet made to other wallets. A watch-only wallet built from a
// full viewing key sees these too, which lets the audit check refunds.
const SENT_QUERY = `
  SELECT o.txid, o.tx_mined_height, t.expiry_height, o.to_address, o.value, o.memo
  FROM v_tx_outputs o JOIN transactions t ON t.id_tx = o.transaction_id
  WHERE o.from_account_uuid IS NOT NULL AND o.to_account_uuid IS NULL AND o.is_change = 0`;

export function readSent(dbPath: string): SentOutput[] {
  return queryRows(dbPath, SENT_QUERY).map((r) => ({
    txid: txidOf(r.txid),
    minedHeight: heightOf(r.tx_mined_height),
    expiryHeight: heightOf(r.expiry_height),
    toAddress: typeof r.to_address === "string" ? r.to_address : null,
    valueZats: BigInt(numberLike(r.value)),
    memo: decodeMemo(r.memo instanceof Uint8Array ? r.memo : null),
  }));
}

// Average seconds per block over the last `count` blocks the wallet has
// scanned, or null if it has too few. Testnet often runs well off the 75 s target.
export function recentBlockSeconds(dbPath: string, count = 20): number | null {
  const rows = queryRows(dbPath, `SELECT height, time FROM blocks ORDER BY height DESC LIMIT ${Math.max(2, count + 1)}`);
  if (rows.length < 3) return null;
  const [newest, oldest] = [rows[0], rows[rows.length - 1]];
  const blocks = Number(numberLike(newest.height)) - Number(numberLike(oldest.height));
  return Math.round((Number(numberLike(newest.time)) - Number(numberLike(oldest.time))) / blocks);
}

// A transaction that was never mined and whose expiry height has passed can no
// longer be mined (consensus rule), so whatever it paid was not paid.
export function expired(s: SentOutput, tip: number): boolean {
  return s.minedHeight === null && !!s.expiryHeight && tip >= s.expiryHeight;
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

function unsealedWhenMined(o: ReceivedOutput, sealedUntil: number): boolean {
  // Without the block's time we cannot show the bid was sealed when it landed.
  if (o.minedTime === null || o.minedTime === undefined) throw new Error(`no block time for ${o.txid} at height ${o.minedHeight}`);
  return o.minedTime >= sealedUntil;
}

export function scanBids(outputs: ReceivedOutput[], window: Window): BidScan {
  const scan: BidScan = { bids: [], rejected: [] };
  for (const o of outputs) {
    const id = `${o.txid}:${o.outputIndex}`;
    const memo = o.memo === null ? null : parseBidMemo(o.memo);
    const reject = (reason: Rejected["reason"]) =>
      scan.rejected.push({ id, valueZats: o.valueZats, reason, ...(memo?.refundTo && { refundTo: memo.refundTo }), ...(memo && { maxPrice: memo.maxPrice }) });
    // A payment with no bid memo is not a bid at any height (a fee float, a
    // tip); only a real bid that misses the window is owed a refund as late.
    if (!memo) { reject("no bid memo"); continue; }
    if (o.minedHeight === null) { reject("unmined"); continue; }
    if (o.minedHeight < window.startHeight || o.minedHeight > window.endHeight) { reject("outside window"); continue; }
    if (window.sealedUntil !== undefined && unsealedWhenMined(o, window.sealedUntil)) { reject("outside window"); continue; }
    scan.bids.push({ txid: id, amountZats: o.valueZats, minedHeight: o.minedHeight, ...memo });
  }
  return scan;
}
