// Bid memo format, carried in the encrypted memo of a shielded Zcash payment:
//
//   SC1 BID c=<commitment, 64 hex> p=<max price, zatoshis per whole token> [b=<budget, zatoshis>] [r=<refund address>]
//
// The budget appears only on fixed-deposit launches: every bid pays the same
// deposit, and the budget says how much of it the bid may spend.
//
// The commitment is sha256(claimPubkey || salt). It reveals nothing about the
// bidder until they claim on Solana with the matching key.

import { createHash } from "node:crypto";

export interface BidMemo {
  commitment: string;
  maxPrice: bigint;
  budget?: bigint;
  refundTo?: string;
}

const MEMO_RE = /^SC1 BID c=([0-9a-f]{64}) p=([1-9][0-9]{0,18})(?: b=([1-9][0-9]{0,18}))?(?: r=(\S+))?$/;

export function parseBidMemo(raw: string): BidMemo | null {
  // Zcash memos are 512 bytes; text memos may arrive padded with NULs.
  const memo = raw.replace(/\0+$/, "").trim();
  const m = MEMO_RE.exec(memo);
  if (!m) return null;
  const parsed: BidMemo = { commitment: m[1], maxPrice: BigInt(m[2]) };
  if (m[3]) parsed.budget = BigInt(m[3]);
  if (m[4]) parsed.refundTo = m[4];
  return parsed;
}

export const MEMO_MAX_BYTES = 512;

export function formatBidMemo(bid: BidMemo): string {
  const base = `SC1 BID c=${bid.commitment} p=${bid.maxPrice}${bid.budget !== undefined ? ` b=${bid.budget}` : ""}`;
  return assertMemoFits(bid.refundTo ? `${base} r=${bid.refundTo}` : base);
}

export function assertMemoFits(memo: string): string {
  const size = Buffer.byteLength(memo, "utf8");
  if (size > MEMO_MAX_BYTES) throw new Error(`memo is ${size} bytes; Zcash memos hold ${MEMO_MAX_BYTES}`);
  return memo;
}

export function makeCommitment(claimPubkey: Uint8Array, salt: Uint8Array): string {
  if (claimPubkey.length !== 32) throw new Error("claim pubkey must be 32 bytes");
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");
  return createHash("sha256").update(claimPubkey).update(salt).digest("hex");
}
