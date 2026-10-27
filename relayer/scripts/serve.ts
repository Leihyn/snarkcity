// Serves the city (web/) and its data at /api/launches.
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

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { recentBlockSeconds } from "../../watcher/src/bids.ts";
import { chainTip, refresh } from "../../watcher/src/devtool.ts";
import { fetchLaunch, loadKeypair, program, type LaunchState } from "../src/client.ts";
import { expandHome, type PublicTerms } from "../src/launch-file.ts";
import { Auditor, launchFiles } from "../src/auditor.ts";
import { ClaimRelay, type Allocation } from "../src/relay.ts";
import { launchStatus, type SettlementSummary } from "../src/status.ts";

const configPath = resolve(process.argv[2]);
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const at = (p: string) => resolve(configPath, "..", p);
const webRoot = at(cfg.web);
const launchPaths: string[] = cfg.launches.map(at);
const terms = (p: string): PublicTerms => JSON.parse(readFileSync(p, "utf8"));

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

// Solana state, cached briefly per launch.
const solanaCache = new Map<string, { at: number; state: LaunchState | null }>();
async function onChain(t: PublicTerms): Promise<LaunchState | null> {
  const hit = solanaCache.get(t.launchId);
  if (hit && Date.now() - hit.at < 10_000) return hit.state;
  let state: LaunchState | null = hit?.state ?? null;
  try {
    const p = program(new Connection(t.rpc, "confirmed"), Keypair.generate());
    state = await fetchLaunch(p, new PublicKey(t.creator), BigInt(t.launchId));
  } catch (e) {
    console.error(`solana state for ${t.name} not updated: ${(e as Error).message.split("\n")[0]}`);
  }
  solanaCache.set(t.launchId, { at: Date.now(), state });
  return state;
}

function settlementOf(publicPath: string): SettlementSummary | null {
  const p = publicPath.replace(/\.public\.json$/, ".settlement.json");
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, "utf8"));
  return { price: s.price, tokensSold: s.tokensSold, raisedZats: s.raisedZats, bids: s.outcomes.length };
}

async function launches() {
  return Promise.all(launchPaths.map(async (p) => {
    const t = terms(p);
    return { ...launchStatus(t, zcashTip, await onChain(t), settlementOf(p)), ...(blockSeconds && { blockSeconds }) };
  }));
}

const relay = cfg.relayerKeypair
  ? new ClaimRelay(new Connection(terms(launchPaths[0]).rpc, "confirmed"), loadKeypair(expandHome(cfg.relayerKeypair)))
  : null;

const auditor = new Auditor(cfg.devtool);
// Audit every launch with a published key now, so the audit page opens on a
// report rather than a first sync of the chain.
for (const p of launchPaths) auditor.start(p);

function auditRoute(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  const [, , , id, file] = urlPath.split("/");
  const path = launchPaths.find((p) => terms(p).launchId === id);
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
  const path = launchPaths.find((p) => terms(p).launchId === launchId);
  if (!path) throw new Error("unknown launch");
  const t = terms(path);
  const state = await onChain(t);
  if (!state?.finalized || state.noSale) throw new Error(`${t.name} has no result to claim yet`);
  const settlement = JSON.parse(readFileSync(path.replace(/\.public\.json$/, ".settlement.json"), "utf8"));
  return { t, claims: settlement.claims as Allocation[] };
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

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (urlPath === "/api/launches") {
    const body = JSON.stringify({ zcashTip, launches: await launches() });
    return res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(body);
  }
  if (req.method === "POST" && ["/api/claim/prepare", "/api/claim/submit", "/api/claim/status"].includes(urlPath)) return api(req, res, urlPath);
  if (urlPath.startsWith("/api/audit/")) return auditRoute(req, res, urlPath);
  sendFile(res, urlPath);
}).listen(cfg.port, cfg.host ?? "127.0.0.1", () => console.log(`SnarkCity: http://127.0.0.1:${cfg.port}/  (zcash height ${zcashTip})`));
