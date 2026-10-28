// Gives a launch a FROST-held wallet before it opens: a 2-of-3 RedPallas key
// split into three shares, and a watch-only launch wallet built from the
// group's viewing key. No single file can spend the bids; refunds need two
// shares (see frost/README.md). Run before open-launch.
//
//   node scripts/frost-wallet.ts [--dkg <frostd host:port>] <launch.json> <synced-wallet-dir> <frost-client> <zcash-sign> <frost-sign2>
//
// The synced wallet (any) gives the chain height for the new wallet's birthday.
//
// Without --dkg the shares come from a trusted dealer: one process makes the
// whole key and splits it. With --dkg the three holders run distributed key
// generation through a frostd server instead; each holder's process only ever
// sees its own share, so the whole key never exists anywhere. frost-client
// talks to frostd over HTTPS only; for a local frostd with a self-signed
// certificate, point SSL_CERT_FILE at its CA (frost-client reads it).

import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { chainTip, initWatchOnly, refresh } from "../../watcher/src/devtool.ts";
import { readLaunch, writeJson } from "../src/launch-file.ts";

const run = promisify(execFile);
const argv = process.argv.slice(2);
const dkgServer = argv[0] === "--dkg" ? argv.splice(0, 2)[1] : undefined;
const [path, tipWalletDir, frostClient, zcashSign, frostSign] = argv;
const HOLDERS = ["alice", "bob", "carol"];
const THRESHOLD = 2;
const DKG_TIMEOUT_MS = 180_000;

const launch = readLaunch(path);
if (launch.custody) throw new Error(`${launch.name} already has FROST custody`);
if (launch.solana.launchId) throw new Error(`${launch.name} is already open; custody is set before opening`);
if (existsSync(launch.zcash.walletDir)) throw new Error(`${launch.zcash.walletDir} exists; use a fresh wallet directory`);

const sharesDir = join(dirname(launch.zcash.walletDir), "frost-shares");
mkdirSync(sharesDir, { recursive: true, mode: 0o700 });
const shares = HOLDERS.map((h) => join(sharesDir, `${h}.toml`));
const description = `${launch.name} launch wallet`;
for (const s of shares) await run(frostClient, ["init", "-c", s]);
// init writes the holder's communication key; DKG writes the share. Both stay private to the holder.
for (const s of shares) chmodSync(s, 0o600);
if (dkgServer) await distributedKeygen(dkgServer);
else await run(frostClient, ["trusted-dealer", "-C", "redpallas", "-d", description, "-N", HOLDERS.join(","), ...shares.flatMap((s) => ["-c", s])]);
for (const s of shares) chmodSync(s, 0o600);

// The group verifying key names the group's section in each config file.
const groups = shares.map((s) => /^\[group\.([0-9a-f]{64})\]$/m.exec(readFileSync(s, "utf8"))?.[1]);
const group = groups[0];
if (!group) throw new Error("no FROST group found in the new share files");
if (groups.some((g) => g !== group)) throw new Error("the holders' share files disagree on the group key");
const generated = (await run(zcashSign, ["generate", "--ak", group, "-n", "test"])).stdout;
const ufvk = /Unified Full Viewing Key: (\S+)/.exec(generated)?.[1];
if (!ufvk) throw new Error("zcash-sign did not print a viewing key");

const tipWallet = { bin: launch.zcash.devtool, dir: tipWalletDir };
await refresh(tipWallet);
await initWatchOnly({ bin: launch.zcash.devtool, dir: launch.zcash.walletDir }, ufvk, (await chainTip(tipWallet)) - 1);

launch.custody = { kind: "frost", group, shares, signers: [0, 1], zcashSign, frostSign };
delete launch.zcash.identity;
writeJson(path, launch);
console.log(`${launch.name}: FROST ${THRESHOLD}-of-${HOLDERS.length} wallet ready (${dkgServer ? "DKG" : "trusted dealer"}, group key ${group.slice(0, 16)}…); shares in ${sharesDir}`);

// Runs DKG with each holder as its own frost-client process. Holders first
// swap contacts (public communication keys), so frostd only relays messages
// encrypted between them. The first holder opens the session naming the
// others; they can only join once it exists, so they start after it does.
async function distributedKeygen(server: string): Promise<void> {
  const pubkeys = await exchangeContacts();
  const args = (s: string) => ["dkg", "-C", "redpallas", "-d", description, "-s", server, "-t", String(THRESHOLD), "-c", s];
  let opened!: () => void;
  const sessionOpen = new Promise<void>((r) => (opened = r));
  const first = holderProcess(HOLDERS[0], [...args(shares[0]), "-S", pubkeys.slice(1).join(",")], (line) => {
    if (/Getting session info/.test(line)) opened();
  });
  await Promise.race([sessionOpen, first]);
  await Promise.all([first, ...shares.slice(1).map((s, i) => holderProcess(HOLDERS[i + 1], args(s)))]);
}

// Each holder exports its contact and imports the other two. Returns the
// holders' communication public keys (hex), in HOLDERS order.
async function exchangeContacts(): Promise<string[]> {
  const exported = await Promise.all(HOLDERS.map((h, i) => run(frostClient, ["export", "-n", h, "-c", shares[i]])));
  const contacts = exported.map(({ stderr }) => stderr.trim().split("\n").pop()?.trim() ?? "");
  const pubkeys = exported.map(({ stderr }) => /Public Key: ([0-9a-f]+)/.exec(stderr)?.[1] ?? "");
  if (contacts.some((c) => !c.startsWith("zffrost1")) || pubkeys.some((p) => !p)) throw new Error("frost-client export printed no contact");
  for (const [i, s] of shares.entries())
    for (const [j, c] of contacts.entries()) if (i !== j) await run(frostClient, ["import", c, "-c", s]);
  return pubkeys;
}

// One holder's frost-client run. Its output carries no secrets (the share goes
// straight to the holder's config file), so stderr is kept for the error message.
function holderProcess(holder: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(frostClient, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill(), DKG_TIMEOUT_MS);
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => {
      log += d;
      for (const line of String(d).split("\n")) onLine?.(line);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${holder}'s DKG exited ${code}: ${log.trim().split("\n").slice(-4).join(" | ")}`));
    });
  });
}
