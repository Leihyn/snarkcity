import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frostPayUri, payments, signPczt } from "../src/frost.ts";
import { toPaymentUri, type Payout } from "../src/payouts.ts";

const batch: Payout[] = [
  { bidId: "abc:0", to: "utest1refund", zats: 99_999n, memo: "SC1 RCPT bid=abc:0 tok=1000 px=300/1 refund=99999" },
  { bidId: "def:1", to: "utest1other", zats: 100_000_000n, memo: "SC1 RCPT bid=def:1 tok=0 px=none refund=100000000" },
  { bidId: "ghi:2", to: "utest1third", zats: 1n, memo: "" },
];

test("a FROST payout reads back exactly the payouts payouts.ts planned", () => {
  assert.deepEqual(payments(toPaymentUri(batch)), batch.map(({ to, zats, memo }) => ({ to, zats, memo })));
  assert.deepEqual(payments(toPaymentUri(batch.slice(0, 1))), [{ to: "utest1refund", zats: 99_999n, memo: batch[0].memo }]);
});

test("a FROST payout refuses a payment with no amount", () => {
  assert.throws(() => payments("zcash:?address=utest1a&amount=1&address.1=utest1b"), /payment 1 has no amount/);
});

// Stand-ins for zcash-devtool and zcash-sign: the first logs each `pczt` call
// and answers like the real one; the second asks for one signature per spend.
function fakeTools(dir: string, spends: number) {
  const log = join(dir, "calls.log");
  const devtool = join(dir, "zcash-devtool");
  writeFileSync(devtool, `#!/bin/sh
printf '%s\n' "$*" >> "${log}"
case "$4" in
  create) shift 4; while [ $# -gt 0 ]; do [ "$1" = --output ] && echo plan > "$2"; shift; done ;;
  prove) echo proven ;;
  send) echo "Sending transaction..."; echo "${"cd".repeat(32)}" ;;
esac
`);
  const zcashSign = join(dir, "zcash-sign");
  const randomizers = Array.from({ length: spends }, (_, i) => `echo "Randomizer #${i + 1} (ironwood): ${"aa".repeat(32)}"`).join("\n");
  writeFileSync(zcashSign, `#!/bin/sh
out=$5
echo "SIGHASH: ${"11".repeat(32)}"
${randomizers}
: > "$out"
i=0; while [ $i -lt ${spends} ]; do read s; echo "$s" >> "$out"; i=$((i + 1)); done
`);
  const frostSign = join(dir, "frost-sign2");
  writeFileSync(frostSign, `#!/bin/sh\necho sign >> "${log}"\nprintf '%0128d\\n' 0\n`);
  for (const f of [devtool, zcashSign, frostSign]) chmodSync(f, 0o755);
  return { log, devtool, zcashSign, frostSign };
}

test("a FROST batch pays every recipient in one transaction, signed once per spend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-frost-test-"));
  const { log, devtool, zcashSign, frostSign } = fakeTools(dir, 2);
  const uri = toPaymentUri(batch);
  const txid = await frostPayUri({ bin: devtool, dir: "wallet" }, { kind: "frost", group: "00", shares: ["s0", "s1", "s2"], signers: [0, 1], zcashSign, frostSign }, uri);
  assert.equal(txid, "cd".repeat(32));
  const all = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(all.filter((l) => l === "sign").length, 2, "one signature per spend, none per output");
  const calls = all.filter((l) => l !== "sign");
  assert.equal(calls.length, 3, "one create, one prove, one send: a single transaction");
  assert.match(calls[0], /^pczt -w wallet create --uri (\S+) --output /);
  assert.equal(/--uri (\S+)/.exec(calls[0])?.[1], uri, "the whole request goes to pczt create");
  assert.match(calls[1], /^pczt -w wallet prove /);
  assert.match(calls[2], /^pczt -w wallet send /);
});

test("FROST signatures go back in spend order, even when the first one is slower", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-frost-test-"));
  // Stands in for zcash-sign: prints both randomizers, then reads one signature each, in order.
  const zcashSign = join(dir, "zcash-sign");
  writeFileSync(zcashSign, `#!/bin/sh
out=$5
echo "SIGHASH: ${"11".repeat(32)}"
echo "Randomizer #1 (ironwood): ${"aa".repeat(32)}"
echo "Randomizer #2 (ironwood): ${"bb".repeat(32)}"
read s1; read s2
printf '%s\\n%s\\n' "$s1" "$s2" > "$out"
`);
  // Stands in for frost-sign2: slow for the first spend, so it finishes last.
  const frostSign = join(dir, "frost-sign2");
  writeFileSync(frostSign, `#!/bin/sh
case "$5" in aa*) sleep 1; printf '%0128d\\n' 1 | tr 0 a ;; *) printf '%0128d\\n' 2 | tr 0 b ;; esac
`);
  chmodSync(zcashSign, 0o755);
  chmodSync(frostSign, 0o755);
  const out = join(dir, "signed");
  await signPczt({ kind: "frost", group: "00", shares: ["s0", "s1", "s2"], signers: [0, 1], zcashSign, frostSign }, "in", out);
  const [first, second] = readFileSync(out, "utf8").trim().split("\n");
  assert.match(first, /^a+1$/, "spend #1's signature first");
  assert.match(second, /^b+2$/, "spend #2's signature second");
});
