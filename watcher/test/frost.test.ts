import { test } from "node:test";
import assert from "node:assert/strict";
import { singlePayment } from "../src/frost.ts";
import { toPaymentUri } from "../src/payouts.ts";

test("a FROST payout reads back exactly the payout payouts.ts planned", () => {
  const memo = "SC1 RECEIPT b=abc:0 t=1000 p=300/1 r=99999";
  const uri = toPaymentUri([{ bidId: "abc:0", to: "utest1refund", zats: 99_999n, memo }]);
  assert.deepEqual(singlePayment(uri), { to: "utest1refund", zats: 99_999n, memo });
  assert.equal(singlePayment(toPaymentUri([{ bidId: "x", to: "utest1a", zats: 100_000_000n, memo: "m" }])).zats, 100_000_000n);
});

test("a FROST payout refuses a request with more than one recipient", () => {
  const uri = toPaymentUri([
    { bidId: "a", to: "utest1a", zats: 1n, memo: "a" },
    { bidId: "b", to: "utest1b", zats: 2n, memo: "b" },
  ]);
  assert.throws(() => singlePayment(uri), /exactly one recipient/);
});

test("FROST signatures go back in spend order, even when the first one is slower", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { signPczt } = await import("../src/frost.ts");
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
