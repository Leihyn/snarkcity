// Client for the snark_claim program. Two roles:
//   - the launch creator sets up a launch, posts the allocation root and
//     withdraws unsold tokens;
//   - the relayer builds each claim transaction and pays its fees and rent,
//     while the bidder's claim key (the one committed to in the Zcash bid
//     memo) signs it. The claim key signs the whole message, so the relayer
//     cannot change the recipient.

import anchor from "@coral-xyz/anchor";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import idl from "./snark_claim.idl.json" with { type: "json" };

const { AnchorProvider, BN, Program, Wallet } = anchor;
export const PROGRAM_ID = new PublicKey(idl.address);

export function program(connection: Connection, wallet: Keypair) {
  return new Program(idl as anchor.Idl, new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" }));
}

export function launchPda(creator: PublicKey, launchId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(launchId);
  return PublicKey.findProgramAddressSync([Buffer.from("launch"), creator.toBuffer(), id], PROGRAM_ID)[0];
}

export function vaultPda(launch: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), launch.toBuffer()], PROGRAM_ID)[0];
}

export function receiptPda(launch: PublicKey, commitment: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("claimed"), launch.toBuffer(), commitment], PROGRAM_ID)[0];
}

export async function createLaunch(p: anchor.Program, creator: PublicKey, mint: PublicKey, launchId: bigint, supply: bigint) {
  const launch = launchPda(creator, launchId);
  return p.methods
    .createLaunch(new BN(launchId.toString()), new BN(supply.toString()))
    .accountsPartial({
      creator, mint, launch, vault: vaultPda(launch),
      creatorToken: getAssociatedTokenAddressSync(mint, creator),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function setRoot(p: anchor.Program, creator: PublicKey, launchId: bigint, rootHex: string, allocated: bigint) {
  return p.methods
    .setRoot([...Buffer.from(rootHex, "hex")], new BN(allocated.toString()))
    .accountsPartial({ creator, launch: launchPda(creator, launchId) })
    .rpc();
}

export async function withdrawUnsold(p: anchor.Program, creator: PublicKey, mint: PublicKey, launchId: bigint) {
  const launch = launchPda(creator, launchId);
  return p.methods
    .withdrawUnsold()
    .accountsPartial({
      creator, launch, vault: vaultPda(launch),
      creatorToken: getAssociatedTokenAddressSync(mint, creator), tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

export interface LaunchState {
  creator: string;
  mint: string;
  supply: bigint;
  root: string | null; // hex; null until the creator posts it
  allocated: bigint;
  claimed: bigint;
  unsoldWithdrawn: boolean;
}

export async function fetchLaunch(p: anchor.Program, creator: PublicKey, launchId: bigint): Promise<LaunchState> {
  // Account names from the IDL are camel-cased by the Anchor client.
  const a = await (p.account as Record<string, { fetch(k: PublicKey): Promise<Record<string, unknown>> }>).launch.fetch(
    launchPda(creator, launchId),
  );
  const root = Buffer.from(a.root as number[]);
  return {
    creator: (a.creator as PublicKey).toBase58(),
    mint: (a.mint as PublicKey).toBase58(),
    supply: BigInt(String(a.supply)),
    root: root.equals(Buffer.alloc(32)) ? null : root.toString("hex"),
    allocated: BigInt(String(a.allocated)),
    claimed: BigInt(String(a.claimed)),
    unsoldWithdrawn: Boolean(a.unsoldWithdrawn),
  };
}

export interface Allocation {
  commitment: string; // hex
  tokens: bigint;
  proof: string[]; // hex
}

// Builds a claim transaction paid by the relayer. The recipient's token account
// is created in the same transaction if it does not exist. The caller still has
// to collect two signatures: the claim key's and the relayer's.
export async function buildClaim(
  p: anchor.Program, relayer: PublicKey, claimKey: PublicKey, creator: PublicKey, mint: PublicKey,
  launchId: bigint, alloc: Allocation, salt: Buffer, recipientOwner: PublicKey = claimKey,
): Promise<Transaction> {
  const launch = launchPda(creator, launchId);
  const commitment = Buffer.from(alloc.commitment, "hex");
  const recipientToken = getAssociatedTokenAddressSync(mint, recipientOwner);
  const createAta = createAssociatedTokenAccountIdempotentInstruction(relayer, recipientToken, recipientOwner, mint);
  const claimIx = await p.methods
    .claim([...commitment], [...salt], new BN(alloc.tokens.toString()), alloc.proof.map((h) => [...Buffer.from(h, "hex")]))
    .accountsPartial({
      payer: relayer, claimer: claimKey, launch, vault: vaultPda(launch), recipientToken,
      receipt: receiptPda(launch, commitment), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .instruction();
  const tx = new Transaction().add(createAta, claimIx);
  tx.feePayer = relayer;
  tx.recentBlockhash = (await p.provider.connection.getLatestBlockhash("confirmed")).blockhash;
  return tx;
}

// The bid secret file written by watcher/scripts/make-bid.ts holds the claim
// key as PKCS#8 DER. Its last 32 bytes are the ed25519 seed Solana keys use.
export function claimKeyFromBidFile(path: string): { keypair: Keypair; salt: Buffer; commitment: string } {
  const bid = JSON.parse(readFileSync(path, "utf8"));
  const der = Buffer.from(bid.claimPrivateKeyPkcs8, "hex");
  createPrivateKey({ key: der, format: "der", type: "pkcs8" }); // throws if the file is malformed
  const keypair = Keypair.fromSeed(der.subarray(-32));
  if (keypair.publicKey.toBuffer().toString("hex") !== bid.claimPubkey) throw new Error(`${path}: key does not match its public key`);
  return { keypair, salt: Buffer.from(bid.salt, "hex"), commitment: bid.commitment };
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
