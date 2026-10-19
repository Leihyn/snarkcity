// Thin wrapper around the zcash-devtool CLI. It connects to the lightwalletd
// server directly, which keeps a sync to a couple of seconds.
//
// The testnet server drops connections now and then (HTTP/2 GoAway, a TLS
// close without notify, or a stall that hits our time limit). Calls that only
// read or sync are retried; calls that send money are not, because a send can
// fail after its transaction went out, and a blind retry would pay twice.
// Payouts recover by re-planning instead (see payouts.ts: receiptedBids).

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Wallet {
  bin: string; // path to the zcash-devtool binary
  dir: string; // wallet directory
  identity?: string; // age identity file; only needed to send
}

// Without a limit a stalled call would hang the operator tool forever.
const CALL_TIMEOUT_MS = 180_000;

async function devtool(w: Wallet, args: string[]): Promise<string> {
  const { stdout } = await run(w.bin, ["wallet", "-w", w.dir, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: CALL_TIMEOUT_MS,
  });
  return stdout;
}

const TRANSIENT =
  /deadline has elapsed|timed? ?out|peer closed connection|close_notify|GoAway|connection (reset|refused|closed)|transport error|broken pipe|unexpected eof|status: Unavailable|ECONNRESET|ETIMEDOUT/i;

// True for failures worth retrying: our own time limit, or a network error.
export function isTransient(e: unknown): boolean {
  const err = e as { killed?: boolean; message?: string; stderr?: string };
  if (err.killed) return true;
  return TRANSIENT.test(`${err.message ?? ""}\n${err.stderr ?? ""}`);
}

export const retryPolicy = { attempts: 4, delayMs: 5_000 };

export async function withRetry<T>(fn: () => Promise<T>, onRetry?: () => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retryPolicy.attempts || !isTransient(e)) throw e;
      onRetry?.();
      await new Promise((r) => setTimeout(r, retryPolicy.delayMs * attempt));
    }
  }
}

const read = (w: Wallet, args: string[]) => withRetry(() => devtool(w, args));

// Compact blocks carry no memos, so a sync is followed by an enhance pass that
// fetches the full transactions and decrypts them. Both resume where they left off.
export async function refresh(w: Wallet): Promise<void> {
  await read(w, ["sync"]);
  await read(w, ["enhance"]);
}

// Not retried: see the note at the top.
export async function send(w: Wallet, address: string, zats: bigint, memo: string): Promise<string> {
  if (!w.identity) throw new Error("sending needs the wallet's age identity file");
  return lastTxid(await devtool(w, ["send", "-i", w.identity, "--address", address, "--value", zats.toString(), "--memo", memo]));
}

// Pays every entry of a ZIP 321 payment request in one transaction. Not retried.
export async function pay(w: Wallet, paymentUri: string): Promise<string> {
  if (!w.identity) throw new Error("paying needs the wallet's age identity file");
  // Without --disable-confirmation, pay waits on stdin for a yes/no that a script never gives.
  return lastTxid(await devtool(w, ["pay", "-i", w.identity, "--disable-confirmation", "--payment-uri", paymentUri]));
}

// Creates a watch-only wallet from a unified full viewing key. A failed attempt
// can leave a half-made wallet, so it is removed before retrying, but only if
// this call created the directory.
export async function initWatchOnly(w: Wallet, ufvk: string, birthday: number): Promise<void> {
  const fresh = !existsSync(w.dir);
  await withRetry(
    () => devtool(w, ["init-fvk", "--name", "audit", "--fvk", ufvk, "--birthday", String(birthday)]),
    () => fresh && rmSync(w.dir, { recursive: true, force: true }),
  );
}

// Chain height as of the wallet's last sync.
export async function chainTip(w: Wallet): Promise<number> {
  const m = /chain_tip_height: BlockHeight\(\s*(\d+)/.exec(await read(w, ["balance"]));
  if (!m) throw new Error("balance output has no chain tip");
  return Number(m[1]);
}

// Shielded funds the wallet can spend now, and funds still waiting for
// confirmations (zcash-devtool's default: 10 for notes received from others).
export async function shieldedBalance(w: Wallet): Promise<{ spendable: bigint; pending: bigint }> {
  const out = await read(w, ["balance"]);
  let spendable = 0n;
  let pending = 0n;
  const pool = /(sapling|orchard|ironwood)_balance: Balance \{(.*?)\}/gs;
  for (const [, , body] of out.matchAll(pool)) {
    const field = (name: string) => BigInt(new RegExp(`${name}: Zatoshis\\(\\s*(\\d+)`).exec(body)?.[1] ?? "0");
    spendable += field("spendable_value");
    pending += field("value_pending_spendability") + field("change_pending_confirmation");
  }
  return { spendable, pending };
}

// The wallet's first unified address, where bids are sent.
export async function defaultAddress(w: Wallet): Promise<string> {
  const m = /utest1[0-9a-z]+|u1[0-9a-z]+/.exec(await read(w, ["list-addresses"]));
  if (!m) throw new Error("wallet has no unified address");
  return m[0];
}

// The single-receiver encodings inside an address, via `zcash-devtool inspect`
// (local decoding, no network). A unified address lists each receiver as
// "- <Kind> (<encoding>)".
export async function receivers(bin: string, address: string): Promise<string[]> {
  // inspect prints its report on stderr, so read both streams.
  const { stdout, stderr } = await run(bin, ["inspect", address]);
  const found = [...`${stdout}\n${stderr}`.matchAll(/^\s+- [A-Za-z0-9 ]+ \((\S+)\)$/gm)].map((m) => m[1]);
  return found.length > 0 ? found : [address];
}

function lastTxid(out: string): string {
  const txid = out.trim().split("\n").pop()?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`no txid in output: ${out.slice(-200)}`);
  return txid;
}
