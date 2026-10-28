// Runs the public audit for the city's audit page. Each launch's files sit
// together: <name>.public.json (terms), <name>.viewkey.txt (published by
// close-launch), and <name>.audit.json (the last report, written here). Each
// launch runs one audit at a time, since each one syncs its watch-only wallet.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { auditLaunch, toJson } from "./audit-launch.ts";
import type { PublicTerms } from "./launch-file.ts";

export const launchFiles = (publicPath: string) => {
  const base = publicPath.replace(/\.public\.json$/, "");
  return { terms: publicPath, viewKey: `${base}.viewkey.txt`, report: `${base}.audit.json`, watchDir: join(dirname(publicPath), "audit-wallet") };
};

// A re-run is refused within this long of the last one finishing.
const RERUN_AFTER_MS = 60_000;

// Whether server start re-checks a launch. A passed audit of a final launch is
// kept: nothing it checks can change any more, and re-running thousands of
// them would sync thousands of wallets at every start. A launch never audited
// waits until someone asks for its report.
export function auditOnStart(saved: { ok: boolean } | null, final: boolean): boolean {
  return saved !== null && !(saved.ok && final);
}

export class Auditor {
  private running = new Set<string>();
  private errors = new Map<string, string>();
  private devtool: string;
  constructor(devtool: string) {
    this.devtool = devtool;
  }

  view(publicPath: string) {
    const f = launchFiles(publicPath);
    const viewingKey = existsSync(f.viewKey) ? readFileSync(f.viewKey, "utf8").trim() : null;
    const saved = existsSync(f.report) ? JSON.parse(readFileSync(f.report, "utf8")) : null;
    return {
      viewingKey,
      report: saved?.report ?? null,
      checkedAt: saved?.checkedAt ?? null,
      running: this.running.has(publicPath),
      error: this.errors.get(publicPath) ?? null,
      files: { terms: basename(f.terms), viewKey: basename(f.viewKey) }, // names the downloads get
    };
  }

  // Starts an audit unless one is running, there is no viewing key yet, or the
  // last one is fresh. Returns at once; the page polls view().
  start(publicPath: string, force = false) {
    const v = this.view(publicPath);
    const fresh = v.checkedAt !== null && Date.now() - Date.parse(v.checkedAt) < RERUN_AFTER_MS;
    if (v.running || !v.viewingKey || (v.report && (!force || fresh))) return;
    this.running.add(publicPath);
    this.errors.delete(publicPath);
    this.run(publicPath, v.viewingKey)
      .catch((e) => this.errors.set(publicPath, (e as Error).message.split("\n")[0]))
      .finally(() => this.running.delete(publicPath));
  }

  // Server start: re-runs a stored audit that failed or predates the result.
  startIfStale(publicPath: string, final: boolean) {
    if (auditOnStart(this.view(publicPath).report, final)) this.start(publicPath, true);
  }

  private async run(publicPath: string, viewingKey: string) {
    const f = launchFiles(publicPath);
    const terms: PublicTerms = JSON.parse(readFileSync(f.terms, "utf8"));
    const report = await auditLaunch(terms, viewingKey, f.watchDir, this.devtool);
    writeFileSync(f.report, toJson({ checkedAt: new Date().toISOString(), report }));
  }
}
