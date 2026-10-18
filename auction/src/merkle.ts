// Allocation fingerprint. The Solana claim program verifies proofs against the
// root, so the hashing here must match the program exactly:
//
//   leaf = sha256(0x00 || commitment (32 bytes) || tokens (u64 little-endian))
//   node = sha256(0x01 || min(a, b) || max(a, b))   (sorted pair)
//
// The 0x00/0x01 prefixes keep a leaf from being passed off as an inner node.
// An odd node at the end of a layer is carried up unchanged.

import { createHash } from "node:crypto";

export interface Allocation {
  commitment: string; // 64 hex
  tokens: bigint;
}

const U64_MAX = (1n << 64n) - 1n;

export function leafHash(a: Allocation): Buffer {
  if (a.tokens < 0n || a.tokens > U64_MAX) throw new Error("tokens out of u64 range");
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(a.tokens);
  return sha256(Buffer.from([0]), Buffer.from(a.commitment, "hex"), amount);
}

function nodeHash(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.from([1]), lo, hi);
}

export function buildLayers(allocations: Allocation[]): Buffer[][] {
  if (allocations.length === 0) throw new Error("no allocations");
  const layers = [allocations.map(leafHash)];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? nodeHash(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  return layers;
}

export function rootOf(layers: Buffer[][]): Buffer {
  return layers[layers.length - 1][0];
}

export function proofFor(layers: Buffer[][], index: number): Buffer[] {
  const proof: Buffer[] = [];
  for (const layer of layers.slice(0, -1)) {
    const sibling = index ^ 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    index >>= 1;
  }
  return proof;
}

export function verifyProof(a: Allocation, proof: Buffer[], root: Buffer): boolean {
  let h = leafHash(a);
  for (const sibling of proof) h = nodeHash(h, sibling);
  return h.equals(root);
}

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
