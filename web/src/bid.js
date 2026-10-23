// A sealed bid, made entirely in the browser. Nothing here talks to a server:
// the claim key is created with WebCrypto, kept in memory, and leaves only in
// the bid file the bidder saves. Formats match the command-line tools
// (auction/src/memo.ts, watcher/scripts/make-bid.ts), so the same bid file
// works with relayer/scripts/claim.ts. No DOM here, so it runs under `node --test`.

const ZAT = 100_000_000n;
export const MEMO_MAX_BYTES = 512;
// Mirrors LATE_BID_MARGIN in relayer/src/phase.ts: a bid can take a few blocks
// to be mined, and one mined after the window closes is refunded, not counted.
export const LATE_BID_MARGIN = 5;

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

// "0.0004" -> 40000n. At most 8 decimals; anything else is not a ZEC amount.
export function parseZec(text) {
  const m = /^\s*(\d{1,8})?(?:\.(\d{1,8}))?\s*$/.exec(String(text));
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return BigInt(m[1] ?? 0) * ZAT + BigInt((m[2] ?? '').padEnd(8, '0') || 0);
}

export function formatZec(zats) {
  const whole = zats / ZAT;
  const frac = (zats % ZAT).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// Refunds go back to this address, so it must be a Zcash testnet address.
export function refundAddressProblem(addr) {
  if (!addr) return 'A refund address is needed: anything not spent on tokens is sent back there.';
  if (!/^(utest1|ztestsapling1|tm)[0-9a-z]+$/i.test(addr)) return 'That is not a Zcash testnet address (utest1…, ztestsapling1… or tm…).';
  return null;
}

// Checks the inputs against the launch's public terms. Returns the parsed
// values, or the first problem as a sentence.
export function checkBid({ price, amount, refundTo }, launch) {
  const maxPrice = parseZec(price);
  const amountZats = parseZec(amount);
  if (maxPrice === null || maxPrice === 0n) return { problem: 'Enter your maximum price in ZEC per token.' };
  if (maxPrice < BigInt(launch.reservePrice)) return { problem: `The reserve price is ${formatZec(BigInt(launch.reservePrice))} ZEC per token. Bids below it are refunded.` };
  if (amountZats === null || amountZats === 0n) return { problem: 'Enter how much ZEC to send.' };
  const refund = refundAddressProblem(refundTo.trim());
  if (refund) return { problem: refund };
  // Tokens the budget buys at your own maximum price: the fewest you get if
  // you win in full. A lower clearing price buys more with the same budget.
  const tokensAtMax = (amountZats * 10n ** BigInt(launch.decimals)) / maxPrice;
  if (tokensAtMax === 0n) return { problem: 'That amount does not buy any tokens at your price.' };
  return { maxPrice, amountZats, refundTo: refundTo.trim(), tokensAtMax };
}

export function bidMemo({ commitment, maxPrice, refundTo }) {
  const memo = `SC1 BID c=${commitment} p=${maxPrice}${refundTo ? ` r=${refundTo}` : ''}`;
  const size = new TextEncoder().encode(memo).length;
  if (size > MEMO_MAX_BYTES) throw new Error(`memo is ${size} bytes; Zcash memos hold ${MEMO_MAX_BYTES}`);
  return memo;
}

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ZIP 321 payment request: a wallet that scans it fills in address, amount and memo.
export function paymentUri(address, amountZats, memo) {
  return `zcash:${address}?amount=${formatZec(amountZats)}&memo=${base64url(new TextEncoder().encode(memo))}`;
}

// A fresh ed25519 claim key (the key type Solana uses) and a random salt,
// committed to as sha256(pubkey || salt).
export async function makeClaimKey(crypto = globalThis.crypto) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pubkey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array([...pubkey, ...salt]));
  return { claimPubkey: hex(pubkey), claimPrivateKeyPkcs8: hex(pkcs8), salt: hex(salt), commitment: hex(digest) };
}

// The file the bidder keeps. The first four fields are what claim.ts reads;
// the rest says which launch and payment it belongs to.
export function bidFile(key, launch, bid, memo) {
  return {
    ...key,
    launch: { name: launch.name, launchId: launch.launchId, programId: launch.programId, mint: launch.mint, bidAddress: launch.bidAddress, endHeight: launch.endHeight },
    maxPrice: bid.maxPrice.toString(),
    amountZats: bid.amountZats.toString(),
    refundTo: bid.refundTo,
    memo,
    createdAt: new Date().toISOString(),
  };
}

export function bidFileName(launch, commitment) {
  return `snarkcity-bid-${launch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${commitment.slice(0, 8)}.json`;
}

// What the bidder is told about timing.
export function timing(launch) {
  if (launch.phase === 'lot') return { open: false, note: `Bidding opens in ${launch.blocksToStart} blocks. A bid mined before then is refunded.` };
  if (launch.phase !== 'bidding') return { open: false, note: 'Bidding has closed.' };
  if (launch.blocksLeft < LATE_BID_MARGIN) {
    return { open: true, late: true, note: `Only ${launch.blocksLeft} block${launch.blocksLeft === 1 ? '' : 's'} left. A payment can take a few blocks to be mined; if yours lands after block ${launch.endHeight.toLocaleString('en-US')} it is refunded, not counted.` };
  }
  return { open: true, late: false, note: `${launch.blocksLeft} blocks left (about ${Math.round(launch.blocksLeft * 75 / 60)} minutes). Bids mined after block ${launch.endHeight.toLocaleString('en-US')} are refunded.` };
}
