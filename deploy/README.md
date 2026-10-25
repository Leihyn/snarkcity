# Hosting the SnarkCity web server

Two ways to put the city online:

- **Static snapshot (no server).** `node deploy/snapshot.ts http://127.0.0.1:5174 <out-dir>` copies the page and saves what it reads: the launches, each launch's audit report, its terms and its viewing key. Any static host serves the folder (it includes a `vercel.json` that sets JSON content types on the extensionless `/api/` paths). Visitors browse the city, open audits and download the files to run the audit themselves; bidding and claiming are hidden, and the page says it is a snapshot. Tested by serving the folder with `python3 -m http.server`: the city, the snapshot note, the audit dialog and both downloads worked, with no console errors.
- **Live server (the container below).** Everything, including bidding and claims, with no Zcash spending keys in the container.

One container runs `relayer/scripts/serve.ts`: the three.js city at `/`, launch
state at `/api/launches`, the public audit at `/api/audit/<id>`, and relayed
claims. It needs the `zcash-devtool` CLI to follow the Zcash chain, so the image
builds that from source too.

## What is in the image, and what is not

**The image contains no keys.** It holds code only: `auction/`, `watcher/`,
`relayer/`, `web/` with production `node_modules`, Node 25 and the
`zcash-devtool` binary.

- **Zcash spending keys never go in the image or the data volume.** No launch
  `wallet/` dir, no `identity.age`, no `keys.toml` with a mnemonic, no
  `*.secret*` file. `export-data.sh` refuses to copy any of them and aborts.
  The only Zcash wallets the server gets are the watch-only `audit-wallet/`
  dirs, built from viewing keys that are already published.
- **The Solana devnet relayer keypair is mounted at runtime**, read-only, at
  `/run/secrets/relayer-keypair.json`. It is never baked into a layer. Without
  it, run `export-data.sh --no-relayer` and the server answers claims with 503.
- The build context is an allowlist (`deploy/Dockerfile.dockerignore`): wallets,
  secrets, `.env` files, `node_modules` and the Anchor `program/` never reach
  the builder.

## Quick start

From the repo root:

```sh
# 1. Build (the first build compiles zcash-devtool from source; see Troubleshooting for time and disk)
docker buildx build --load -f deploy/Dockerfile -t snarkcity:local .

# 2. Export the public data named in your city.json
deploy/export-data.sh ~/Desktop/dev/zec-tools/wallets/city.json ./snarkcity-data

# 3. Run
docker run -d --name snarkcity -p 5180:5174 \
  -v "$PWD/snarkcity-data:/data" \
  -v ~/.config/solana/id.json:/run/secrets/relayer-keypair.json:ro \
  snarkcity:local

curl -s localhost:5180/api/launches | head -c 300
```

`serve.ts` listens on `cfg.host`, defaulting to `127.0.0.1`. The container
`city.json` written by `export-data.sh` sets `"host": "0.0.0.0"` so the port
mapping reaches it.

**Status:** the Dockerfile has not been built yet. The first build attempt
stopped for lack of disk space before any Rust compiled; plan on about 8 GB
free. `export-data.sh` and the exported data were tested by serving them
directly on macOS (`/api/launches` with a live Zcash tip, the city page, and
an audit route all answered).

## What the data volume holds

`export-data.sh <city.json> <out-dir>` reads the `launches` list from your
city.json and writes:

```
<out-dir>/
  city.json                       container config, all paths under /data
  tip-wallet/                     copy of one audit-wallet; follows the chain tip
  launches/<launch-dir>/
    <name>.public.json            terms (required)
    <name>.settlement.json        published settlement, if any
    <name>.viewkey.txt            published viewing key, if any
    <name>.audit.json             last audit report, if any
    audit-wallet/                 watch-only wallet for the audit, if any
```

The server writes to this volume: audit reports (`<name>.audit.json`) and
wallet syncs. The container runs as uid 1000, so the script makes the tree
writable for it. The tip wallet is a separate copy so the 30-second tip sync
and a launch audit never sync the same sqlite file at once.

A launch with no `audit-wallet/` yet (no viewing key published) is still
listed; the server creates its audit wallet once a viewing key appears.

## Troubleshooting

**`unknown flag: --progress` or "the legacy builder is deprecated"**
The Docker CLI has no buildx plugin (for example after removing Docker Desktop
and using colima). The Dockerfile needs BuildKit: it fetches zcash-devtool with
`ADD <git url>#<rev>` and uses `Dockerfile.dockerignore`. Install buildx
(`brew install docker-buildx`) or put the release binary in
`~/.docker/cli-plugins/docker-buildx`.

**`error getting credentials` on pull**
`~/.docker/config.json` still says `"credsStore": "desktop"` but Docker Desktop
is gone. Remove that line, or build with `DOCKER_CONFIG` pointing at a dir
whose `config.json` is `{}`.

**Build fails or the disk fills during the zcash-devtool stage**
The Rust stage is the heavy part: the rust image, the crate sources and a
release `target/` together need several GB inside the VM, on top of the VM
itself. Keep 8 GB or more free before building. The stage deletes `target/`
and the cargo cache before it ends, so the final image does not carry them.

**Container exits at once with ENOENT on `/run/secrets/relayer-keypair.json`**
`serve.ts` loads the relayer keypair at start-up when city.json names one.
Mount it, or re-export with `--no-relayer`.

**`/api/launches` shows `zcashTip: 0`**
The tip wallet has not synced yet (the first poll runs before the server
listens and is retried every 30 s), or lightwalletd is unreachable from the
container. The log line `zcash height not updated: ...` says which.

**Audit reports are not written (EACCES)**
The data dir is not writable by uid 1000. Re-run `export-data.sh` (it sets
the permissions) or `chmod -R go+rwX <out-dir>`.

**`export-data: refusing ...`**
The script found key material where only public data should be. Check the
named file; do not work around the check. Nothing is left in the output dir.

## Pinned versions

- `rust:1.98.1-slim-trixie` (build stage)
- `node:25.9.0-trixie-slim` (deps and runtime)
- zcash-devtool `0b3436bb8d235c67cd36b800cb45a7b1b489c415` (`--build-arg DEVTOOL_REV=` to change)
