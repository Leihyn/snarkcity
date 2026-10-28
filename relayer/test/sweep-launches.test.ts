import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = join(import.meta.dirname, "..", "scripts", "sweep-launches.ts");

test("the sweep re-closes only final launches, and one failure does not stop the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-sweep-"));
  // "open" has no settlement, so it is not final; "done" and "gone" are final,
  // but neither has its launch file, so close-launch fails on each.
  for (const name of ["done", "gone"]) writeFileSync(join(dir, `${name}.settlement.json`), "{}");
  writeFileSync(join(dir, "city.json"), JSON.stringify({ launches: ["open.public.json", "done.public.json", join(dir, "gone.public.json")] }));
  const { stdout } = await run(process.execPath, [script, join(dir, "city.json")]);
  const lines = stdout.trim().split("\n");
  assert.match(lines[0], /sweeping 2 final launches of 3$/);
  assert.match(lines[1], /^ {2}done: failed \(exit 1\): .*Error.*done\.json/);
  assert.match(lines[2], /^ {2}gone: failed \(exit 1\): .*Error.*gone\.json/);
  assert.equal(lines.length, 3);
});

test("the sweep refuses a bad interval", async () => {
  await assert.rejects(run(process.execPath, [script, "city.json", "--every", "0"]), /above zero/);
});
