// Sealed bids: the private part of a bid (claim-key commitment, maximum price,
// refund address) is time-lock encrypted to a future drand round. drand's
// quicknet, a threshold network run by independent organisations, publishes
// each round's signature on schedule; that signature is the only key that opens
// the bid. Until then nobody can read it, the launch operator included; after
// it, everyone can, so the public audit still works.
//
// Used by the browser (bid screen) and by the watcher (settlement and audit).
// No DOM, no Node APIs: WebCrypto only.
//
// Memo layout (ZIP 302 arbitrary data, first byte 0xFF), at most 512 bytes:
//   0      0xFF
//   1..3   "SC2"
//   4..11  drand round, u64 big-endian
//   12..   timelock-encrypted AES key: U (96) | V (32) | W (32)
//   172..  AES-GCM IV (12)
//   184..  ciphertext length, u16 big-endian
//   186..  AES-256-GCM ciphertext of commitment (32) | max price u64 (8) | refund address
//          (UTF-8, zero-padded so every sealed memo is exactly 512 bytes and its
//          length says nothing about the address)
// The first 12 bytes are authenticated as associated data, so the round cannot be swapped.

import { decryptOnG2, encryptOnG2RFC9380, hashedRoundNumber } from '../vendor/tlock-ibe.js';

// drand quicknet (bls-unchained-g1-rfc9380). Pinned: a launch cannot name its
// own key, or an operator could seal bids to a key it holds.
export const DRAND = {
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesis: 1692803367,
  period: 3,
};

const MAGIC = [0xff, 0x53, 0x43, 0x32]; // 0xFF "SC2"
const HEADER = 12, KEY_CT = 160, IV = 12, LEN = 2, BODY = HEADER + KEY_CT + IV + LEN;
const MEMO_MAX = 512, TAG = 16;
const ADDRESS_ROOM = MEMO_MAX - BODY - TAG - 40; // 270 bytes for the refund address
const hex = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// The first round published at or after a unix time, and when a round is published.
export const roundAt = (unixSeconds) => Math.max(1, Math.ceil((unixSeconds - DRAND.genesis) / DRAND.period) + 1);
export const roundTime = (round) => DRAND.genesis + (round - 1) * DRAND.period;

function u64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

async function aesKey(raw, use, crypto) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [use]);
}

// Seals a bid to a drand round. Returns the memo bytes.
export async function sealBid({ commitment, maxPrice, refundTo }, round, crypto = globalThis.crypto) {
  const header = Uint8Array.from([...MAGIC, ...u64(round)]);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const address = new TextEncoder().encode(refundTo ?? '');
  if (address.length > ADDRESS_ROOM) throw new Error(`refund address is ${address.length} bytes; a sealed bid holds ${ADDRESS_ROOM}`);
  const plain = new Uint8Array(40 + ADDRESS_ROOM);
  plain.set([...hex(commitment), ...u64(maxPrice)]);
  plain.set(address, 40);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, await aesKey(key, 'encrypt', crypto), plain));
  const k = await encryptOnG2RFC9380(hex(DRAND.publicKey), hashedRoundNumber(round), key);
  const memo = Uint8Array.from([...header, ...k.U, ...k.V, ...k.W, ...iv, ct.length >> 8, ct.length & 255, ...ct]);
  return memo;
}

// The drand round a sealed memo opens at, or null if it is not a sealed bid.
export function sealedRound(memo) {
  if (!memo || memo.length < BODY + TAG + 40 || MAGIC.some((b, i) => memo[i] !== b)) return null;
  return Number(new DataView(memo.buffer, memo.byteOffset + 4, 8).getBigUint64(0));
}

// Opens a sealed memo with the round's drand signature (hex). Returns the bid,
// or null if the memo is malformed, sealed to another round, or tampered with.
export async function openBid(memo, signatureHex, crypto = globalThis.crypto) {
  if (sealedRound(memo) === null) return null;
  const len = (memo[BODY - 2] << 8) | memo[BODY - 1];
  if (BODY + len > memo.length || len < 40 + TAG) return null;
  const U = memo.slice(HEADER, HEADER + 96), V = memo.slice(HEADER + 96, HEADER + 128), W = memo.slice(HEADER + 128, HEADER + 160);
  try {
    const key = await decryptOnG2(hex(signatureHex), { U, V, W });
    const iv = memo.slice(HEADER + KEY_CT, HEADER + KEY_CT + IV);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: memo.slice(0, HEADER) }, await aesKey(key, 'decrypt', crypto), memo.slice(BODY, BODY + len),
    ));
    const refundTo = new TextDecoder('utf-8', { fatal: true }).decode(plain.slice(40)).replace(/\0+$/, '');
    return { commitment: toHex(plain.slice(0, 32)), maxPrice: new DataView(plain.buffer, 32, 8).getBigUint64(0), ...(refundTo && { refundTo }) };
  } catch {
    return null; // wrong round's signature, tampered ciphertext, or bad text
  }
}
