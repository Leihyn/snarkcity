// Claiming tokens with a bid file, in the browser. The relayer builds and pays
// for the Solana transaction; the claim key in the bid file signs it here, and
// the key itself never leaves the page. No DOM, so it runs under `node --test`.

import { base58, claimMessageProblem, decodeAddress } from './solana.js';

const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

// Reads a bid file (from the bid screen or watcher/scripts/make-bid.ts) and
// checks that its key matches its commitment, so a damaged file is caught
// before anything is sent.
export async function readBidFile(text, crypto = globalThis.crypto) {
  let f;
  try { f = JSON.parse(text); } catch { return { problem: 'That is not a bid file (it is not JSON).' }; }
  const hex = (v, len) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${len}}$`).test(v);
  if (!hex(f.claimPubkey, 64) || !hex(f.salt, 32) || !hex(f.commitment, 64) || !hex(f.claimPrivateKeyPkcs8, 96)) {
    return { problem: 'That is not a bid file: the claim key fields are missing or damaged.' };
  }
  const digest = await crypto.subtle.digest('SHA-256', fromHex(f.claimPubkey + f.salt));
  if (toHex(digest) !== f.commitment) return { problem: 'This bid file is damaged: its key does not match its commitment.' };
  return {
    commitment: f.commitment,
    salt: f.salt,
    claimPubkey: f.claimPubkey,
    claimAddress: base58(fromHex(f.claimPubkey)),
    pkcs8: f.claimPrivateKeyPkcs8,
    launchId: f.launch?.launchId ?? null, // older command-line bid files do not record it
    launchName: f.launch?.name ?? null,
  };
}

export function recipientProblem(text) {
  if (!text.trim()) return null; // blank: the claim key's own address
  return decodeAddress(text) ? null : 'That is not a Solana address.';
}

// Signs the relayer's transaction message with the claim key, after checking
// that it pays the chosen recipient. Returns the signature, or a problem.
export async function signClaim(bid, messageBytes, expect, crypto = globalThis.crypto) {
  const problem = claimMessageProblem(messageBytes, { ...expect, claimer: bid.claimAddress });
  if (problem) return { problem: `Not signed: ${problem}.` };
  const key = await crypto.subtle.importKey('pkcs8', fromHex(bid.pkcs8), { name: 'Ed25519' }, false, ['sign']);
  return { signature: new Uint8Array(await crypto.subtle.sign('Ed25519', key, messageBytes)) };
}

export const b64 = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)),
  decode: (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
};
