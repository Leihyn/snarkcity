// Refunds payments that reach a launch address after the launch closed. A
// late bid is refunded in full by close-launch's payout plan, and paid bids
// are skipped, so re-running close-launch on a final launch pays exactly the
// new late arrivals and nothing twice. This runs it for every final launch in
// a city (one whose <name>.settlement.json exists), one after another, and
// logs one line per launch.
//
//   node scripts/sweep-launches.ts <city.json> [--every <minutes>]
//
// With --every it repeats after each pass, waiting that many minutes. Each
// launch file is the one its <name>.public.json was written from (<name>.json,
// alongside it), since only it has the wallet and keys close-launch needs.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const closeLaunch = join(dirname(new URL(import.meta.url).pathname), "close-launch.ts");

const [cityArg, flag, minutesArg] = process.argv.slice(2);
if (!cityArg || (flag !== undefined && flag !== "--every")) throw new Error("usage: sweep-launches.ts <city.json> [--every <minutes>]");
const minutes = flag ? Number(minutesArg) : 0;
if (flag && !(minutes > 0)) throw new Error("--every needs a number of minutes above zero");

const cityPath = resolve(cityArg);
const city: { launches: string[] } = JSON.parse(readFileSync(cityPath, "utf8"));

async function sweep(): Promise<void> {
  const final = city.launches
    .map((p) => resolve(dirname(cityPath), p))
    .filter((p) => existsSync(p.replace(/\.public\.json$/, ".settlement.json")));
  console.log(`${new Date().toISOString()} sweeping ${final.length} final launches of ${city.launches.length}`);
  for (const publicPath of final) {
    const launchPath = publicPath.replace(/\.public\.json$/, ".json");
    const name = basename(launchPath, ".json");
    try {
      const { stdout } = await run(process.execPath, [closeLaunch, launchPath], { cwd: dirname(closeLaunch), maxBuffer: 16 << 20 });
      console.log(`  ${name}: ${summary(stdout)}`);
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string; message: string };
      // Exit code 3 is close-launch's "not ready yet", not a failure.
      const why = err.code === 3 ? summary(err.stdout ?? "") : `failed (exit ${err.code ?? "?"}): ${errorLine(err.stderr || err.message)}`;
      console.log(`  ${name}: ${why}`);
    }
  }
}

// close-launch ends its payout section with a "payouts: N due, ..." line.
function summary(out: string): string {
  return out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("payouts:")) ?? lastLine(out);
}

// Node prints a thrown error's stack and then its version; the Error line says what went wrong.
function errorLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => /^\w*Error\b/.test(l)) ?? lastLine(text);
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? "no output";
}

for (;;) {
  await sweep();
  if (!minutes) break;
  await new Promise((r) => setTimeout(r, minutes * 60_000));
}
