// Claims relayed for browsers. A claim takes two steps: `prepare` builds the
// transaction and hands its message to the browser, which checks it and signs
// with the claim key from the bid file; `submit` adds the relayer's signature
// and sends it. The relayer pays fees and rent, and never sees the claim key.

import { createHash } from "node:crypto";
import { Keypair, PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import { buildClaim, launchPda, program, receiptPda } from "./client.ts";
import type { PublicTerms } from "./launch-file.ts";

export interface ClaimRequest {
  commitment: string;
  claimPubkey: string; // hex
  salt: string; // hex
  recipient?: string; // base58 owner of the receiving token account; blank = the claim key
}

export interface Allocation { commitment: string; tokens: string; proof: string[] }

export type Prepared =
  | { status: "ready"; message: string; tokens: string; recipient: string }
  | { status: "no-allocation" | "claimed" };

// A blockhash lasts about a minute, so an unsigned claim is no use for longer.
const PENDING_MS = 90_000;
const isHex = (v: unknown, len: number) => typeof v === "string" && new RegExp(`^[0-9a-f]{${len}}$`).test(v);

export class ClaimRelay {
  private pending = new Map<string, { tx: Transaction; claimer: PublicKey; expires: number }>();
  private connection: Connection;
  private relayer: Keypair;
  constructor(connection: Connection, relayer: Keypair) {
    this.connection = connection;
    this.relayer = relayer;
  }

  async prepare(terms: PublicTerms, claims: Allocation[], req: ClaimRequest): Promise<Prepared> {
    if (!isHex(req.commitment, 64) || !isHex(req.claimPubkey, 64) || !isHex(req.salt, 32)) throw new Error("malformed claim request");
    const committed = createHash("sha256").update(Buffer.from(req.claimPubkey + req.salt, "hex")).digest("hex");
    if (committed !== req.commitment) throw new Error("the claim key does not match the commitment");
    const entry = claims.find((c) => c.commitment === req.commitment);
    if (!entry) return { status: "no-allocation" };
    const launch = launchPda(new PublicKey(terms.creator), BigInt(terms.launchId));
    const receipt = receiptPda(launch, Buffer.from(req.commitment, "hex"));
    if (await this.connection.getAccountInfo(receipt)) return { status: "claimed" };

    const claimer = new PublicKey(Buffer.from(req.claimPubkey, "hex"));
    const recipient = req.recipient?.trim() ? new PublicKey(req.recipient.trim()) : claimer;
    const tx = await buildClaim(
      program(this.connection, this.relayer), this.relayer.publicKey, claimer, new PublicKey(terms.creator),
      new PublicKey(terms.mint), BigInt(terms.launchId),
      { commitment: entry.commitment, tokens: BigInt(entry.tokens), proof: entry.proof }, Buffer.from(req.salt, "hex"), recipient,
    );
    const message = tx.serializeMessage().toString("base64");
    this.sweep();
    this.pending.set(message, { tx, claimer, expires: Date.now() + PENDING_MS });
    return { status: "ready", message, tokens: entry.tokens, recipient: recipient.toBase58() };
  }

  // Only messages this relay prepared are co-signed, so it pays for nothing else.
  async submit(message: string, signature: string): Promise<string> {
    const p = this.pending.get(message);
    if (!p || p.expires < Date.now()) throw new Error("this claim has expired; start again");
    const sig = Buffer.from(signature, "base64");
    if (sig.length !== 64) throw new Error("malformed signature");
    p.tx.addSignature(p.claimer, sig);
    if (!p.tx.verifySignatures(false)) throw new Error("the signature does not match your claim key");
    p.tx.partialSign(this.relayer);
    const txid = await this.connection.sendRawTransaction(p.tx.serialize());
    this.pending.delete(message);
    await this.connection.confirmTransaction(txid, "confirmed");
    return txid;
  }

  private sweep() {
    for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
  }
}
