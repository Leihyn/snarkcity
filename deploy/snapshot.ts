// Builds a read-only snapshot of the city that any static host can serve
// (GitHub Pages included, under a subpath): the page, its assets, and the API
// answers it reads (launches, audit reports, the terms and viewing key files
// for running the audit yourself). No server, no keys, no chain access. Sealed
// bids can still be made in the browser; claiming is hidden in snapshot mode.
//
//   node deploy/snapshot.ts <running-server-url> <out-dir>
//
// e.g. node deploy/snapshot.ts http://127.0.0.1:5174 /tmp/snarkcity-snapshot

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [server, outArg] = process.argv.slice(2);
if (!server || !outArg) throw new Error("usage: snapshot.ts <running-server-url> <out-dir>");
const out = resolve(outArg);
const web = resolve(import.meta.dirname, "../web");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const p of ["index.html", "styles.css", "src", "vendor", "assets", "node_modules/three/build", "node_modules/three/examples/jsm", "node_modules/uqr/dist"]) {
  cpSync(join(web, p), join(out, p), { recursive: true });
}

async function get(path: string): Promise<Response> {
  const res = await fetch(new URL(path, server), { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

function save(path: string, body: string | Uint8Array) {
  const file = join(out, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

const data = await (await get("/api/launches")).json();
save("api/launches", JSON.stringify({ ...data, snapshot: { takenAt: new Date().toISOString() } }));
for (const l of data.launches as { launchId: string; name: string }[]) {
  const base = `/api/audit/${l.launchId}`;
  const audit = await (await get(`${base}/report`)).json();
  if (audit.running || (audit.viewingKey && !audit.report)) console.warn(`${l.name}: audit still running; snapshot shows it as running`);
  save(`${base}/report`, JSON.stringify({ ...audit, running: false }));
  save(`${base}/terms.json`, new Uint8Array(await (await get(`${base}/terms.json`)).arrayBuffer()));
  if (audit.viewingKey) save(`${base}/viewkey.txt`, `${audit.viewingKey}\n`);
  console.log(`${l.name}: ${audit.report ? (audit.report.ok ? "audit ok" : "audit FAILED") : "no audit yet"}`);
}

// GitHub Pages runs Jekyll unless told not to, and Jekyll drops some files.
save(".nojekyll", "");
console.log(`snapshot written to ${out}`);
