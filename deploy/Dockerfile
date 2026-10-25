# syntax=docker/dockerfile:1.7
#
# SnarkCity web server: relayer/scripts/serve.ts plus the zcash-devtool CLI.
#
#   docker build -f deploy/Dockerfile -t snarkcity:local .     (from the repo root)
#
# The image holds code only. No Zcash key and no Solana keypair is ever copied
# in: public launch data comes from a volume at /data, and the devnet relayer
# keypair is mounted at runtime. See deploy/README.md.

# ---- Stage 1: zcash-devtool, built from source at a pinned upstream revision ----
# Same revision as the local checkout used for the demo (0b3436b on origin/main;
# the local tree matches upstream at that commit). Override with
# --build-arg DEVTOOL_REV=<sha>.
FROM rust:1.98.1-slim-trixie AS devtool
ARG DEVTOOL_REV=0b3436bb8d235c67cd36b800cb45a7b1b489c415
# BuildKit fetches the repo at that commit itself; nothing extra in the image.
ADD https://github.com/zcash/zcash-devtool.git#${DEVTOOL_REV} /src
WORKDIR /src
# Default features only. Not needed: protoc (zcash_client_backend falls back to
# its checked-in protobuf code when protoc is absent) and clang (bindgen comes
# in only through the optional pczt-qr feature). rust:slim already has gcc and
# libc6-dev for the C parts (ring, bundled sqlite, zstd).
# rust-toolchain.toml asks for "stable" plus clippy/rustfmt; pin to the image's
# toolchain so the build does not download a second one.
ENV RUSTUP_TOOLCHAIN=1.98.1 \
    CARGO_INCREMENTAL=0 \
    CARGO_PROFILE_RELEASE_DEBUG=0
RUN cargo build --release --locked \
 && cp target/release/zcash-devtool /usr/local/bin/zcash-devtool \
 && strip /usr/local/bin/zcash-devtool \
 && rm -rf target /usr/local/cargo/registry /usr/local/cargo/git

# ---- Stage 2: production node_modules from each package's lockfile ----
# Only relayer/ and web/ have dependencies (and lockfiles); auction/ and
# watcher/ use node: builtins only.
FROM node:25.9.0-trixie-slim AS deps
WORKDIR /app
COPY relayer/package.json relayer/package-lock.json relayer/
COPY web/package.json web/package-lock.json web/
RUN cd relayer && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && cd ../web && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# ---- Stage 3: runtime ----
FROM node:25.9.0-trixie-slim
# tini reaps the zcash-devtool child processes. ca-certificates for Solana RPC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=devtool /usr/local/bin/zcash-devtool /usr/local/bin/zcash-devtool

WORKDIR /app
# serve.ts imports ../../watcher/src and ../../auction/src: keep the repo layout.
COPY auction/package.json auction/
COPY auction/src auction/src
COPY watcher/package.json watcher/
COPY watcher/src watcher/src
COPY relayer/package.json relayer/package-lock.json relayer/
COPY relayer/src relayer/src
COPY relayer/scripts relayer/scripts
COPY web/ web/
COPY --from=deps /app/relayer/node_modules relayer/node_modules
COPY --from=deps /app/web/node_modules web/node_modules

# /data is the public launch data volume (deploy/export-data.sh makes it). The
# server writes audit reports and syncs the watch-only wallets there, so it
# must be writable by uid 1000 (the image's "node" user).
VOLUME ["/data"]
USER node
WORKDIR /app/relayer
ENV NODE_ENV=production
EXPOSE 5174
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings", "scripts/serve.ts", "/data/city.json"]
