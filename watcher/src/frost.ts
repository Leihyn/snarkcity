// Payouts from a FROST-held launch wallet (see frost/README.md). The launch
// wallet is watch-only; each payout is built as a PCZT, signed by two of the
// three key shares, and sent with `pczt send`, which records it in the wallet
// so a re-run of close-launch sees it pending and never pays twice.
//
// Not retried, like every send: a failure after broadcast must not pay twice.

import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { lastTxid, type Wallet } from "./devtool.ts";

const run = promisify(execFile);
const CALL_TIMEOUT_MS = 180_000;

export interface FrostCustody {
  kind: "frost";
  group: string; // group verifying key (hex): the spend authorizing key of the wallet
  shares: string[]; // frost-client config files, one per key holder
  signers: [number, number]; // which two shares sign (indexes into `shares`)
  zcashSign: string; // frost/zcash-sign-nu7 binary
  frostSign: string; // frost/frost-sign2 binary
}

// Pays one recipient from the FROST wallet. Returns the txid.
export async function frostSend(w: Wallet, c: FrostCustody, to: string, zats: bigint, memo: string): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "sc-frost-"));
  const [plan, proven, signed] = ["plan", "proven", "signed"].map((n) => join(work, `${n}.pczt`));
  try {
    await pczt(w, ["create", "--address", to, "--value", zats.toString(), "--memo", memo, "--output", plan]);
    await pczt(w, ["prove", plan], proven);
    await signPczt(c, proven, signed);
    return lastTxid(await pczt(w, ["send", signed]));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Pays a single-recipient ZIP 321 request (as payouts.ts builds them) with
// frostSend, so close-launch can use the same payout plan for FROST wallets.
export function frostPayUri(w: Wallet, c: FrostCustody, uri: string): Promise<string> {
  const { to, zats, memo } = singlePayment(uri);
  return frostSend(w, c, to, zats, memo);
}

export function singlePayment(uri: string): { to: string; zats: bigint; memo: string } {
  const u = new URL(uri.replace(/^zcash:\?/, "zcash://x/?"));
  const to = u.searchParams.get("address"), amount = u.searchParams.get("amount"), memo = u.searchParams.get("memo");
  if (!to || !amount || u.searchParams.has("address.1")) throw new Error("a FROST payout pays exactly one recipient");
  const [whole, frac = ""] = amount.split(".");
  return { to, zats: BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, "0")), memo: memo ? Buffer.from(memo, "base64url").toString("utf8") : "" };
}

// Runs `zcash-devtool pczt -w <wallet> ...`; with `out`, its stdout (a binary PCZT) goes to that file.
async function pczt(w: Wallet, args: string[], out?: string): Promise<string> {
  if (!out) return (await run(w.bin, ["pczt", "-w", w.dir, ...args], { timeout: CALL_TIMEOUT_MS, maxBuffer: 16 << 20 })).stdout;
  const { stdout } = await run(w.bin, ["pczt", "-w", w.dir, ...args], { timeout: CALL_TIMEOUT_MS, maxBuffer: 16 << 20, encoding: "buffer" });
  writeFileSync(out, stdout);
  return "";
}

// zcash-sign prints the sighash, then for each spend a randomizer, and waits
// for that spend's signature on stdin; frost-sign2 makes it from two shares.
export function signPczt(c: FrostCustody, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(c.zcashSign, ["sign", "-i", input, "-o", output, "-n", "test"], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill(), CALL_TIMEOUT_MS);
    const fail = (e: unknown) => { child.kill(); reject(e); };
    const answer = signer(c, (sig) => child.stdin.write(`${sig}\n`), fail);
    let buffered = "", errors = "";
    child.stderr.on("data", (d) => { errors += d; });
    child.stdout.on("data", (d) => {
      const lines = (buffered + d).split("\n");
      buffered = lines.pop() ?? "";
      lines.forEach(answer);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`zcash-sign exited ${code}: ${errors.trim().split("\n").filter((l) => l.trim()).slice(0, 6).join(" | ")}`));
    });
  });
}

// Reads zcash-sign's output a line at a time. It prints every randomizer
// first, then reads one signature per spend in that order, so signatures are
// made and written strictly one after another, never in finishing order.
function signer(c: FrostCustody, send: (sig: string) => void, fail: (e: unknown) => void) {
  let sighash: string | null = null;
  let queue = Promise.resolve();
  return (line: string) => {
    sighash ??= /^SIGHASH: ([0-9a-f]{64})$/.exec(line)?.[1] ?? null;
    const alpha = /^Randomizer #\d+ \([a-z]+\): ([0-9a-f]{64})$/.exec(line)?.[1];
    if (!alpha) return;
    if (!sighash) return fail(new Error("zcash-sign printed a randomizer before the sighash"));
    const hash = sighash;
    queue = queue.then(() => signShare(c, hash, alpha)).then(send).catch(fail);
  };
}

async function signShare(c: FrostCustody, sighash: string, alpha: string): Promise<string> {
  const [a, b] = c.signers.map((i) => c.shares[i]);
  const { stdout } = await run(c.frostSign, [a, b, c.group, sighash, alpha], { timeout: CALL_TIMEOUT_MS });
  const sig = stdout.trim();
  if (!/^[0-9a-f]{128}$/.test(sig)) throw new Error("frost-sign2 did not return a 64-byte signature");
  return sig;
}
