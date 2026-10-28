// Serves the city (web/) and its data: /api/city (a compact index of every
// launch, with an ETag), /api/launch/<id> (one launch in full) and
// /api/launches (every launch in full, for older pages; ?offset=&limit= pages it).
//
//   node scripts/serve.ts <city.json>
//
// city.json:
//   { "port": 5174, "web": "../web", "devtool": "...", "tipWallet": "<any synced zcash-devtool wallet>",
//     "relayerKeypair": "<solana keypair that pays for claims>", "launches": ["<launch>.public.json", ...],
//     "host": "0.0.0.0" (optional; default 127.0.0.1, set it inside a container) }
//
// A settlement is published next to its terms as <launch>.settlement.json and
// shown only once the launch is final on Solana.
//
// Claims: POST /api/claim/status {launchId, commitment} says whether a bid won
// and whether it is claimed (read-only). POST /api/claim/prepare {launchId, commitment, claimPubkey, salt, recipient?}
// returns the transaction message for the browser to sign; POST /api/claim/submit
// {message, signature} co-signs and sends it. See src/relay.ts.
//
// Audit: GET /api/audit/<launchId>/report returns the published viewing key and
// the last audit report, starting one if there is none; POST to it re-runs it.
// /api/audit/<launchId>/terms.json and /viewkey.txt are the files needed to
// run the same audit yourself (scripts/audit-launch.ts).

import { Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { recentBlockSeconds } from "../../watcher/src/bids.ts";
import { chainTip, refresh } from "../../watcher/src/devtool.ts";
import { fetchLaunches, loadKeypair, type LaunchState } from "../src/client.ts";
import { expandHome, type PublicTerms } from "../src/launch-file.ts";
import { Auditor, launchFiles } from "../src/auditor.ts";
import { ClaimRelay, type Allocation } from "../src/relay.ts";
import { cityEntry, launchStatus, type SettlementSummary } from "../src/status.ts";

const configPath = resolve(process.argv[2]);
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const at = (p: string) => resolve(configPath, "..", p);
const webRoot = at(cfg.web);
const launchPaths: string[] = cfg.launches.map(at);

// Launch files are read once and again only when they change (seed-pool adds
// to the terms, close-launch writes the settlement), so a request over
// thousands of launches does not parse thousands of files.
const fileCache = new Map<string, { mtime: number; value: unknown }>();
function readJson<T>(p: string): T {
  const mtime = statSync(p).mtimeMs;
  const hit = fileCache.get(p);
  if (hit && hit.mtime === mtime) return hit.value as T;
  const value = JSON.parse(readFileSync(p, "utf8"));
  fileCache.set(p, { mtime, value });
  return value;
}
const terms = (p: string): PublicTerms => readJson<PublicTerms>(p);
const pathOf = (launchId: string) => launchPaths.find((p) => terms(p).launchId === launchId);

// Zcash height: refreshed in the background so requests never wait on the chain.
let zcashTip = 0;
let blockSeconds: number | null = null;
async function pollTip() {
  const wallet = { bin: cfg.devtool, dir: at(cfg.tipWallet) };
  try {
    await refresh(wallet);
    zcashTip = await chainTip(wallet);
    blockSeconds = recentBlockSeconds(join(wallet.dir, "data.sqlite"));
  } catch (e) {
    console.error(`zcash height not updated: ${(e as Error).message.split("\n")[0]}`);
  }
}
await pollTip();
setInterval(pollTip, 30_000);

// Solana state per launch. A final launch only changes as tokens are claimed,
// so it is re-read every 2 minutes; others every 10 seconds, to catch the
// result as soon as it is posted.
const FINAL_TTL_MS = 120_000;
const OPEN_TTL_MS = 10_000;
const solanaCache = new Map<string, { at: number; state: LaunchState | null }>();
const stale = (t: PublicTerms) => {
  const hit = solanaCache.get(t.launchId);
  return !hit || Date.now() - hit.at >= (hit.state?.finalized ? FINAL_TTL_MS : OPEN_TTL_MS);
};

// Reads the stale launches in batches, one group per RPC. Requests arriving
// while a read is in flight wait for it instead of starting their own.
let reading: Promise<void> | null = null;
async function readChain(ts: PublicTerms[]) {
  const byRpc = new Map<string, PublicTerms[]>();
  for (const t of ts.filter(stale)) byRpc.set(t.rpc, [...(byRpc.get(t.rpc) ?? []), t]);
  await Promise.all([...byRpc].map(async ([rpc, group]) => {
    try {
      const states = await fetchLaunches(new Connection(rpc, "confirmed"), group);
      group.forEach((t, i) => solanaCache.set(t.launchId, { at: Date.now(), state: states[i] }));
    } catch (e) {
      // Keep what was known and try again when it is next due, so a failing RPC
      // is not hit on every request.
      console.error(`solana state not updated for ${group.length} launches: ${(e as Error).message.split("\n")[0]}`);
      for (const t of group) solanaCache.set(t.launchId, { at: Date.now(), state: solanaCache.get(t.launchId)?.state ?? null });
    }
  }));
}
async function onChainAll(ts: PublicTerms[]): Promise<(LaunchState | null)[]> {
  while (reading) await reading;
  if (ts.some(stale)) {
    reading = readChain(ts).finally(() => { reading = null; });
    await reading;
  }
  return ts.map((t) => solanaCache.get(t.launchId)?.state ?? null);
}
const onChain = async (t: PublicTerms) => (await onChainAll([t]))[0];

function settlementOf(publicPath: string): SettlementSummary | null {
  const p = publicPath.replace(/\.public\.json$/, ".settlement.json");
  if (!existsSync(p)) return null;
  const s = readJson<{ price: SettlementSummary["price"]; tokensSold: string; raisedZats: string; outcomes: unknown[] }>(p);
  return { price: s.price, tokensSold: s.tokensSold, raisedZats: s.raisedZats, bids: s.outcomes.length };
}

// The full status of each launch at the given paths, in order.
async function launches(paths: string[] = launchPaths) {
  const ts = paths.map(terms);
  const states = await onChainAll(ts);
  return ts.map((t, i) => ({ ...launchStatus(t, zcashTip, states[i], settlementOf(paths[i])), ...(blockSeconds && { blockSeconds }) }));
}

async function city() {
  return { zcashTip, ...(blockSeconds && { blockSeconds }), launches: (await launches()).map(cityEntry) };
}

const relay = cfg.relayerKeypair
  ? new ClaimRelay(new Connection(terms(launchPaths[0]).rpc, "confirmed"), loadKeypair(expandHome(cfg.relayerKeypair)))
  : null;

const auditor = new Auditor(cfg.devtool);
// Re-check stored audits that failed or were taken before the result was
// final. Launches never audited are audited when their report is first asked for.
{
  const states = await onChainAll(launchPaths.map(terms));
  launchPaths.forEach((p, i) => auditor.startIfStale(p, states[i]?.finalized ?? false));
}

function auditRoute(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  const [, , , id, file] = urlPath.split("/");
  const path = pathOf(id);
  if (!path) return res.writeHead(404).end("unknown launch");
  if (file && file !== "report") {
    const f = launchFiles(path);
    const source = file === "terms.json" ? f.terms : file === "viewkey.txt" ? f.viewKey : null;
    if (!source || !existsSync(source)) return res.writeHead(404).end("Not found");
    return res.writeHead(200, { "Content-Type": TYPES[extname(source)], "Content-Disposition": `attachment; filename="${source.split(sep).pop()}"` }).end(readFileSync(source));
  }
  auditor.start(path, req.method === "POST");
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(auditor.view(path)));
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error("request too large");
  }
  return JSON.parse(body);
}

// Claims are relayed only for launches that are final on Solana with a sale.
async function claimable(launchId: string) {
  const path = pathOf(launchId);
  if (!path) throw new Error("unknown launch");
  const t = terms(path);
  const state = await onChain(t);
  if (!state?.finalized || state.noSale) throw new Error(`${t.name} has no result to claim yet`);
  const settlement = readJson<{ claims: Allocation[] }>(path.replace(/\.public\.json$/, ".settlement.json"));
  return { t, claims: settlement.claims };
}

async function claimPrepare(body: Record<string, string>) {
  const { t, claims } = await claimable(body.launchId);
  const { commitment, claimPubkey, salt, recipient } = body;
  return relay!.prepare(t, claims, { commitment, claimPubkey, salt, recipient });
}

async function api(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  const reply = (code: number, data: unknown) => res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(data));
  if (!relay) return reply(503, { error: "this server does not relay claims" });
  try {
    const body = await readBody(req);
    if (urlPath === "/api/claim/prepare") return reply(200, await claimPrepare(body));
    if (urlPath === "/api/claim/status") {
      const { t, claims } = await claimable(body.launchId);
      return reply(200, await relay.status(t, claims, body.commitment));
    }
    return reply(200, { signature: await relay.submit(body.message, body.signature) });
  } catch (e) {
    return reply(400, { error: (e as Error).message.split("\n")[0] });
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".glb": "model/gltf-binary", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
};

function sendFile(res: ServerResponse, urlPath: string) {
  let file = normalize(join(webRoot, urlPath));
  if (file !== webRoot && !file.startsWith(webRoot + sep)) return res.writeHead(403).end();
  if (urlPath.endsWith("/")) file = join(file, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end("Not found");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(res);
}

const json = (res: ServerResponse, code: number, data: unknown) =>
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(data));

// The index is polled by every open city, so a client that has the current
// one gets an empty 304. The ETag is a hash of the body: it changes exactly
// when something the city shows does.
async function cityRoute(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.stringify(await city());
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  const headers = { ETag: etag, "Cache-Control": "no-cache" };
  if ((req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim() === etag)) return res.writeHead(304, headers).end();
  res.writeHead(200, { ...headers, "Content-Type": "application/json" }).end(body);
}

// Without offset or limit the whole list, as older pages expect; with either,
// one page of it plus the total.
async function launchesRoute(res: ServerResponse, query: URLSearchParams) {
  if (!query.has("offset") && !query.has("limit")) return json(res, 200, { zcashTip, launches: await launches() });
  const offset = Math.max(0, Number.parseInt(query.get("offset") ?? "0", 10) || 0);
  const limit = Math.max(0, Number.parseInt(query.get("limit") ?? `${launchPaths.length}`, 10) || 0);
  return json(res, 200, { zcashTip, total: launchPaths.length, launches: await launches(launchPaths.slice(offset, offset + limit)) });
}

async function launchRoute(res: ServerResponse, id: string) {
  const path = pathOf(id);
  if (!path) return json(res, 404, { error: "unknown launch" });
  return json(res, 200, (await launches([path]))[0]);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const urlPath = decodeURIComponent(url.pathname);
  if (urlPath === "/api/city") return cityRoute(req, res);
  if (urlPath === "/api/launches") return launchesRoute(res, url.searchParams);
  if (urlPath.startsWith("/api/launch/")) return launchRoute(res, urlPath.slice("/api/launch/".length));
  if (req.method === "POST" && ["/api/claim/prepare", "/api/claim/submit", "/api/claim/status"].includes(urlPath)) return api(req, res, urlPath);
  if (urlPath.startsWith("/api/audit/")) return auditRoute(req, res, urlPath);
  sendFile(res, urlPath);
}).listen(cfg.port, cfg.host ?? "127.0.0.1", () => console.log(`SnarkCity: http://127.0.0.1:${cfg.port}/  (zcash height ${zcashTip})`));
