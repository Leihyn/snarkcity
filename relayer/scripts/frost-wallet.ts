// Gives a launch a FROST-held wallet before it opens: a 2-of-3 RedPallas key
// split into three shares, and a watch-only launch wallet built from the
// group's viewing key. No single file can spend the bids; refunds need two
// shares (see frost/README.md). Run before open-launch.
//
//   node scripts/frost-wallet.ts <launch.json> <synced-wallet-dir> <frost-client> <zcash-sign> <frost-sign2>
//
// The synced wallet (any) gives the chain height for the new wallet's birthday.
// Shares are made by a trusted dealer, which is fine for testnet; a real launch
// would run `frost-client dkg` so that no machine ever holds the whole key.

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { chainTip, initWatchOnly, refresh } from "../../watcher/src/devtool.ts";
import { readLaunch, writeJson } from "../src/launch-file.ts";

const run = promisify(execFile);
const [path, tipWalletDir, frostClient, zcashSign, frostSign] = process.argv.slice(2);
const HOLDERS = ["alice", "bob", "carol"];

const launch = readLaunch(path);
if (launch.custody) throw new Error(`${launch.name} already has FROST custody`);
if (launch.solana.launchId) throw new Error(`${launch.name} is already open; custody is set before opening`);
if (existsSync(launch.zcash.walletDir)) throw new Error(`${launch.zcash.walletDir} exists; use a fresh wallet directory`);

const sharesDir = join(dirname(launch.zcash.walletDir), "frost-shares");
mkdirSync(sharesDir, { recursive: true, mode: 0o700 });
const shares = HOLDERS.map((h) => join(sharesDir, `${h}.toml`));
for (const s of shares) await run(frostClient, ["init", "-c", s]);
await run(frostClient, ["trusted-dealer", "-C", "redpallas", "-d", `${launch.name} launch wallet`, "-N", HOLDERS.join(","), ...shares.flatMap((s) => ["-c", s])]);
for (const s of shares) chmodSync(s, 0o600);

// The group verifying key names the group's section in each config file.
const group = /^\[group\.([0-9a-f]{64})\]$/m.exec(readFileSync(shares[0], "utf8"))?.[1];
if (!group) throw new Error("no FROST group found in the new share files");
const generated = (await run(zcashSign, ["generate", "--ak", group, "-n", "test"])).stdout;
const ufvk = /Unified Full Viewing Key: (\S+)/.exec(generated)?.[1];
if (!ufvk) throw new Error("zcash-sign did not print a viewing key");

const tipWallet = { bin: launch.zcash.devtool, dir: tipWalletDir };
await refresh(tipWallet);
await initWatchOnly({ bin: launch.zcash.devtool, dir: launch.zcash.walletDir }, ufvk, (await chainTip(tipWallet)) - 1);

launch.custody = { kind: "frost", group, shares, signers: [0, 1], zcashSign, frostSign };
delete launch.zcash.identity;
writeJson(path, launch);
console.log(`${launch.name}: FROST 2-of-3 wallet ready (group key ${group.slice(0, 16)}…); shares in ${sharesDir}`);
