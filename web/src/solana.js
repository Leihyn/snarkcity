// Just enough Solana for the browser to check a claim before signing it:
// base58 addresses and the legacy transaction message format. No DOM, no
// dependencies, so it runs under `node --test`.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
// Account order of the claim instruction (program/programs/snark_claim/src/lib.rs, struct Claim).
const CLAIM_ACCOUNTS = ['payer', 'claimer', 'launch', 'vault', 'recipientToken', 'receipt', 'tokenProgram', 'systemProgram'];

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

// A 32-byte Solana address, or null if the text is not one.
export function decodeAddress(text) {
  let n = 0n;
  for (const c of String(text).trim()) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { bytes[i] = Number(n & 255n); n >>= 8n; }
  return n === 0n && base58(bytes) === String(text).trim() ? bytes : null;
}

function reader(bytes) {
  let at = 0;
  const take = (len) => {
    if (at + len > bytes.length) throw new Error('transaction message is truncated');
    const out = bytes.subarray(at, at + len);
    at += len;
    return out;
  };
  const shortVec = () => { // compact-u16
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const b = take(1)[0];
      value |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return value;
    }
  };
  return { take, shortVec, done: () => at === bytes.length };
}

// Decodes a legacy (unversioned) message into signer count, account
// addresses and instructions with their accounts resolved to addresses.
export function parseMessage(bytes) {
  const r = reader(bytes);
  const [signers] = r.take(3);
  if (signers & 0x80) throw new Error('versioned transactions are not expected here');
  const keys = Array.from({ length: r.shortVec() }, () => base58(r.take(32)));
  r.take(32); // recent blockhash
  const instructions = Array.from({ length: r.shortVec() }, () => {
    const program = keys[r.take(1)[0]];
    const accounts = Array.from(r.take(r.shortVec()), (i) => keys[i]);
    const data = Uint8Array.from(r.take(r.shortVec()));
    return { program, accounts, data };
  });
  if (!r.done()) throw new Error('unexpected bytes after the instructions');
  return { signers, keys: keys.slice(0, signers), instructions };
}

// The relayer builds the claim and pays for it; the claim key signs it. The
// program only checks the token account's mint, so before signing, the
// browser confirms the tokens go where the bidder asked: exactly two
// instructions, the second a claim by this key into the token account the
// first one creates for the chosen owner. The token-account program refuses
// to create an account at any address but the owner's own, so that pins it.
export function claimMessageProblem(bytes, { programId, claimer, recipient, mint }) {
  let msg;
  try { msg = parseMessage(bytes); } catch (e) { return e.message; }
  const [create, claim] = msg.instructions;
  if (msg.instructions.length !== 2) return `expected 2 instructions, got ${msg.instructions.length}`;
  if (create.program !== ATA_PROGRAM) return 'the first instruction does not create a token account';
  const [, tokenAccount, owner, createdMint] = create.accounts;
  if (owner !== recipient) return `the token account is for ${owner}, not ${recipient}`;
  if (createdMint !== mint) return 'the token account is for a different token';
  if (claim.program !== programId) return 'the second instruction is not the claim program';
  const named = Object.fromEntries(CLAIM_ACCOUNTS.map((name, i) => [name, claim.accounts[i]]));
  if (named.claimer !== claimer) return 'the claim is not signed by your claim key';
  if (named.recipientToken !== tokenAccount) return 'the claim pays a different token account';
  if (!msg.keys.includes(claimer)) return 'your claim key is not a signer';
  return null;
}
