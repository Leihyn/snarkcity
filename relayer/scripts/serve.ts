// Serves the city (web/) and its data at /api/launches.
//
//   node scripts/serve.ts <city.json>
//
// city.json:
//   { "port": 5174, "web": "../web", "devtool": "...", "tipWallet": "<any synced zcash-devtool wallet>",
//     "launches": ["<launch>.public.json", ...] }
//
// A settlement is published next to its terms as <launch>.settlement.json and
// shown only once the launch is final on Solana.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { chainTip, refresh } from "../../watcher/src/devtool.ts";
import { fetchLaunch, program, type LaunchState } from "../src/client.ts";
import type { PublicTerms } from "../src/launch-file.ts";
import { launchStatus, type SettlementSummary } from "../src/status.ts";

const configPath = resolve(process.argv[2]);
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const at = (p: string) => resolve(configPath, "..", p);
const webRoot = at(cfg.web);
const launchPaths: string[] = cfg.launches.map(at);
const terms = (p: string): PublicTerms => JSON.parse(readFileSync(p, "utf8"));

// Zcash height: refreshed in the background so requests never wait on the chain.
let zcashTip = 0;
async function pollTip() {
  const wallet = { bin: cfg.devtool, dir: at(cfg.tipWallet) };
  try {
    await refresh(wallet);
    zcashTip = await chainTip(wallet);
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
    return launchStatus(t, zcashTip, await onChain(t), settlementOf(p));
  }));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".glb": "model/gltf-binary", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
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
  sendFile(res, urlPath);
}).listen(cfg.port, "127.0.0.1", () => console.log(`SnarkCity: http://127.0.0.1:${cfg.port}/  (zcash height ${zcashTip})`));
