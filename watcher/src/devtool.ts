// Thin wrapper around the zcash-devtool CLI. It connects to the lightwalletd
// server directly, which keeps a sync to a couple of seconds.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Wallet {
  bin: string; // path to the zcash-devtool binary
  dir: string; // wallet directory
  identity?: string; // age identity file; only needed to send
}

// A call to the lightwalletd server occasionally stalls with the connection
// open; without a limit the operator tool would hang forever. Re-running after
// a timeout is safe: payouts skip bids that already have a receipt.
const CALL_TIMEOUT_MS = 180_000;

async function devtool(w: Wallet, args: string[]): Promise<string> {
  const { stdout } = await run(w.bin, ["wallet", "-w", w.dir, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: CALL_TIMEOUT_MS,
  });
  return stdout;
}

// Compact blocks carry no memos, so a sync is followed by an enhance pass that
// fetches the full transactions and decrypts them.
export async function refresh(w: Wallet): Promise<void> {
  await devtool(w, ["sync"]);
  await devtool(w, ["enhance"]);
}

export async function send(w: Wallet, address: string, zats: bigint, memo: string): Promise<string> {
  if (!w.identity) throw new Error("sending needs the wallet's age identity file");
  return lastTxid(await devtool(w, ["send", "-i", w.identity, "--address", address, "--value", zats.toString(), "--memo", memo]));
}

// Pays every entry of a ZIP 321 payment request in one transaction.
export async function pay(w: Wallet, paymentUri: string): Promise<string> {
  if (!w.identity) throw new Error("paying needs the wallet's age identity file");
  // Without --disable-confirmation, pay waits on stdin for a yes/no that a script never gives.
  return lastTxid(await devtool(w, ["pay", "-i", w.identity, "--disable-confirmation", "--payment-uri", paymentUri]));
}

// Creates a watch-only wallet from a unified full viewing key.
export async function initWatchOnly(w: Wallet, ufvk: string, birthday: number): Promise<void> {
  await devtool(w, ["init-fvk", "--name", "audit", "--fvk", ufvk, "--birthday", String(birthday)]);
}

// Chain height as of the wallet's last sync.
export async function chainTip(w: Wallet): Promise<number> {
  const out = await devtool(w, ["balance"]);
  const m = /chain_tip_height: BlockHeight\(\s*(\d+)/.exec(out);
  if (!m) throw new Error("balance output has no chain tip");
  return Number(m[1]);
}

// Shielded funds the wallet can spend now, and funds still waiting for
// confirmations (zcash-devtool's default: 10 for notes received from others).
export async function shieldedBalance(w: Wallet): Promise<{ spendable: bigint; pending: bigint }> {
  const out = await devtool(w, ["balance"]);
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
  const m = /utest1[0-9a-z]+|u1[0-9a-z]+/.exec(await devtool(w, ["list-addresses"]));
  if (!m) throw new Error("wallet has no unified address");
  return m[0];
}

// The single-receiver encodings inside an address, via `zcash-devtool inspect`.
// A unified address lists each receiver as "- <Kind> (<encoding>)".
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
