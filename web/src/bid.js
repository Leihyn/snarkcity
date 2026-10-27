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

// A price per token, typed in ZEC ("0.000004") or in zats ("400"), as zats.
// Tiny ZEC decimals are easy to get wrong by a zero; zats are whole numbers.
export function parsePrice(text, unit = 'zec') {
  if (unit !== 'zats') return parseZec(text);
  const m = /^\s*(\d{1,12})\s*$/.exec(String(text));
  return m ? BigInt(m[1]) : null;
}

// "0.000004 ZEC (400 zats)": both units, so a slipped zero stands out.
export function priceBoth(zats) {
  return `${formatZec(zats)} ZEC (${zats.toLocaleString('en-US')} zats)`;
}

// What the typed price means in the other unit, shown under the field.
export function priceEcho(text, unit = 'zec') {
  const zats = parsePrice(text, unit);
  if (zats === null || zats === 0n) return '';
  return unit === 'zats' ? `= ${formatZec(zats)} ZEC per token` : `= ${zats.toLocaleString('en-US')} zats per token`;
}

// Refunds go back to this address, so it must be a Zcash testnet address.
export function refundAddressProblem(addr) {
  if (!addr) return 'A refund address is needed: anything not spent on tokens is sent back there.';
  if (!/^(utest1|ztestsapling1|tm)[0-9a-z]+$/i.test(addr)) return 'That is not a Zcash testnet address (utest1…, ztestsapling1… or tm…).';
  return null;
}

// Checks the inputs against the launch's public terms. Returns the parsed
// values, or the first problem as a sentence.
export function checkBid({ price, priceUnit = 'zec', amount, refundTo }, launch) {
  const maxPrice = parsePrice(price, priceUnit);
  const amountZats = parseZec(amount);
  if (maxPrice === null || maxPrice === 0n) return { problem: `Enter your maximum price in ${priceUnit === 'zats' ? 'zats' : 'ZEC'} per token.` };
  if (maxPrice < BigInt(launch.reservePrice)) return { problem: `The reserve price is ${priceBoth(BigInt(launch.reservePrice))} per token. Bids below it are refunded.` };
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

// ZIP 321 payment request: a wallet that scans it fills in address, amount and
// memo. The memo is text, or bytes for a sealed bid.
export function paymentUri(address, amountZats, memo) {
  const bytes = typeof memo === 'string' ? new TextEncoder().encode(memo) : memo;
  return `zcash:${address}?amount=${formatZec(amountZats)}&memo=${base64url(bytes)}`;
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
    launch: { name: launch.name, launchId: launch.launchId, programId: launch.programId, mint: launch.mint, bidAddress: launch.bidAddress, endHeight: launch.endHeight, ...(launch.seal && { seal: launch.seal }) },
    maxPrice: bid.maxPrice.toString(),
    amountZats: bid.amountZats.toString(),
    refundTo: bid.refundTo,
    ...(typeof memo === 'string' ? { memo } : { memoHex: [...memo].map((b) => b.toString(16).padStart(2, '0')).join('') }),
    createdAt: new Date().toISOString(),
  };
}

// Rebuilds the payment for a saved bid file, so a bid can be paid after the
// dialog was closed. Returns the payment, or the first problem as a sentence.
export function resumeBid(text, launch) {
  let f;
  try { f = JSON.parse(text); } catch { return { problem: 'That file is not a bid file (it is not JSON).' }; }
  if (!f?.launch?.launchId || !f.amountZats || !(f.memo || f.memoHex)) return { problem: 'That file is not a bid file made by this page.' };
  if (f.launch.launchId !== launch.launchId) return { problem: `This bid file is for ${f.launch.name}, not ${launch.name}.` };
  if (f.launch.bidAddress !== launch.bidAddress) return { problem: 'This bid file names a different launch address. Make a new bid.' };
  if (!/^[0-9a-f]*$/.test(f.memoHex ?? '') || (f.memoHex ?? '').length % 2) return { problem: 'The bid file is damaged: its memo cannot be read.' };
  const memo = f.memoHex ? Uint8Array.from(f.memoHex.match(/../g), (b) => parseInt(b, 16)) : f.memo;
  const amountZats = BigInt(f.amountZats);
  return { commitment: f.commitment, amountZats, memo, uri: paymentUri(launch.bidAddress, amountZats, memo) };
}

export function bidFileName(launch, commitment) {
  return `snarkcity-bid-${launch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${commitment.slice(0, 8)}.json`;
}

// Seconds per block, measured by the server when it can, else Zcash's 75 s target.
const blockSeconds = (launch) => launch.blockSeconds ?? 75;
// A sealed launch stops taking bids when its seal opens, if that comes first.
const SEAL_MARGIN_SECONDS = 300;

// What the bidder is told about timing. `now` is unix seconds.
export function timing(launch, now = Date.now() / 1000) {
  if (launch.phase === 'lot') return { open: false, note: `Bidding opens in ${launch.blocksToStart} blocks. A bid mined before then is refunded.` };
  if (launch.phase !== 'bidding') return { open: false, note: 'Bidding has closed.' };
  if (launch.seal && now >= launch.seal.revealAt) return { open: false, note: 'The seal has opened, so bidding has closed: a bid mined now would be refunded as late.' };
  if (launch.seal && launch.seal.revealAt - now < SEAL_MARGIN_SECONDS) {
    return { open: true, late: true, note: `The seal opens in under ${Math.ceil((launch.seal.revealAt - now) / 60)} minutes. A bid mined after that is refunded as late.` };
  }
  if (launch.blocksLeft < LATE_BID_MARGIN) {
    return { open: true, late: true, note: `Only ${launch.blocksLeft} block${launch.blocksLeft === 1 ? '' : 's'} left. A payment can take a few blocks to be mined; if yours lands after block ${launch.endHeight.toLocaleString('en-US')} it is refunded, not counted.` };
  }
  return { open: true, late: false, note: `${launch.blocksLeft} blocks left (about ${Math.max(1, Math.round(launch.blocksLeft * blockSeconds(launch) / 60))} minutes). Bids mined after block ${launch.endHeight.toLocaleString('en-US')} are refunded.` };
}
