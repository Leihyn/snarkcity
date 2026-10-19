// Pays one batch of refunds and receipts without ever paying twice.
//
// If the server drops the connection during `pay`, the transaction may or may
// not have gone out. The wallet records a transaction when it builds it, so:
//   - receipts recorded (mined or not yet expired): the batch is in flight;
//     do not retry. If it never reaches the chain it expires, and a later run
//     pays it again (receiptedBids ignores expired, never-mined transactions);
//   - nothing recorded: nothing can land, so one retry is safe.

import type { SentOutput } from "./bids.ts";
import { isTransient } from "./devtool.ts";
import { receiptedBids, toPaymentUri, type Payout } from "./payouts.ts";

export interface PayDeps {
  pay(uri: string): Promise<string>;
  refresh(): Promise<void>;
  chainTip(): Promise<number>;
  readSent(): SentOutput[];
}

export type BatchResult =
  | { status: "paid"; txid: string }
  | { status: "in flight" }
  | { status: "failed"; error: string };

export async function payBatch(batch: Payout[], deps: PayDeps): Promise<BatchResult> {
  const uri = toPaymentUri(batch);
  try {
    return { status: "paid", txid: await deps.pay(uri) };
  } catch (e) {
    if (!isTransient(e)) throw e;
  }
  await deps.refresh();
  const recorded = receiptedBids(deps.readSent(), await deps.chainTip());
  if (batch.some((p) => recorded.has(p.bidId))) return { status: "in flight" };
  try {
    return { status: "paid", txid: await deps.pay(uri) };
  } catch (e) {
    return { status: "failed", error: (e as Error).message.split("\n")[0] };
  }
}
