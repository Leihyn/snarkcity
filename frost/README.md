# FROST custody for launch wallets

A launch wallet holds every bid until refunds go out. With FROST, no single key
can spend it: the wallet is controlled by a 2-of-3 threshold key (RedPallas,
rerandomized FROST), and every payout needs two of the three key holders to
sign. The launch wallet itself is watch-only, built from the group's viewing
key, so it can receive bids and build payouts but never sign them.

## Where this code comes from

- `zcash-sign-nu7/` is the Zcash Foundation's `zcash-sign`
  ([frost-zcash-demo](https://github.com/ZcashFoundation/frost-zcash-demo) at
  `53df99c`, MIT/Apache-2.0, licenses included), ported for SnarkCity to the
  librustzcash revision zcash-devtool uses (`eb38d7a`). Upstream `zcash-sign`
  predates NU7 and fails on today's testnet transactions with
  `UnknownConsensusBranchId`. The port moves it to `pczt 0.10.0-pre.2`,
  `orchard 0.16` (whose `unstable-frost` feature replaces the patched orchard
  fork upstream depends on) and `zcash_protocol 0.11.0-pre.1`. `sign.rs` is
  upstream's with the Ywallet path removed; `generate.rs` rebuilds upstream's
  key derivation with orchard 0.16's public API.
- `frost-sign2/` is a small signer written for SnarkCity on the Zcash
  Foundation's `reddsa` and `frost-core`/`frost-rerandomized`: it runs both
  FROST rounds for two key holders in one process and prints only the
  aggregated signature, after checking it against the randomized key.
- Key generation uses the Zcash Foundation's `frost-client dkg`, coordinated
  by their `frostd` server (same repo and commit), or `frost-client
  trusted-dealer` for quick tests.

## How the key is made

`relayer/scripts/frost-wallet.ts --dkg <frostd host:port>` runs distributed
key generation: each of the three holders runs its own `frost-client dkg`
process, after swapping contacts (communication public keys) so that `frostd`
only relays messages encrypted between them. Each process ends with its own
share in its own config file; the full spending key is never computed by
anyone. Without `--dkg` the script falls back to a trusted dealer, which makes
the whole key in one process and splits it.

`frostd` only speaks HTTPS. For a local run, make a CA and a `localhost`
certificate (openssl is enough), start
`frostd -i 127.0.0.1 -p 2744 -c localhost.pem -k localhost.key`, and run the
script with `SSL_CERT_FILE=ca.pem`, which `frost-client` reads for its trusted
roots. Build `frostd` with `cargo build --release -p frostd` in
frost-zcash-demo at `53df99c` (about 600 MB of build files).

## How a payout is signed

1. `zcash-devtool pczt create --uri <ZIP 321 request>` and `pczt prove`
   build the payout from the watch-only wallet: one transaction for a batch
   of up to 8 payouts, one output and receipt memo each. `--uri` is a small
   SnarkCity patch to zcash-devtool (upstream `pczt create` takes one
   `--address`).
2. `zcash-sign sign` prints the transaction's sighash and one randomizer per
   spend, then reads one signature per spend.
3. `frost-sign2` signs each with two key shares.
4. `zcash-devtool pczt send` broadcasts it and records it in the wallet, so a
   re-run of `close-launch` sees the payment and never pays twice.

`watcher/src/frost.ts` drives these steps; `relayer/scripts/frost-wallet.ts`
sets up a launch's key and wallet.

## Proven on testnet

- On 2026-10-25 a 2-of-3 key received 0.004 TAZ in the Ironwood pool and spent
  0.003 TAZ back with a two-share signature: testnet transaction
  `a68f1077570133a25e614756fe17ed48959167649b3b902be3c979b2cd4b47af`, mined at
  height 4539854.
- On 2026-10-28 a 2-of-3 key made by DKG (three `frost-client dkg`
  processes through a local `frostd`, no dealer) received 0.002 TAZ in
  transaction
  `9b1105974ccd3735d9fc4a67b2979ce9b2a1cf4e9263c7cdefad6e1954e1699a`
  (height 4551398) and, after 10 confirmations, spent 0.0015 TAZ back through
  `frostSend` with two of its shares: transaction
  `9cba1c2e5f8a5cb31a0550da58ebde1b3ebbb9183608dcb719629205dd9fd121`, mined
  at height 4551412.
- On 2026-10-28 the same DKG key paid two recipients in one transaction,
  as close-launch now batches FROST payouts: `frostPayUri` built one PCZT
  from a two-payment ZIP 321 request (0.001 and 0.0012 TAZ, each with its own
  memo), two shares signed both of its spends, and it was sent as
  transaction
  `1f44e677dcad1b030c4f8d7aa4a7a3a11ebeb8c46c08deff9507a9312b4bbd76`, mined
  at height 4551661 (funded by
  `7aa745eee61ec401cebdf6409cb5ed6e8d8bd44fea2f0b6966c5f2d686caf17a`, height
  4551649).
- On 2026-10-25 the Halo launch ran with FROST custody end to end: five sealed
  bids in, then five refunds and receipts out, each signed by two shares
  through `close-launch`. The public audit confirmed every refund paid.
- One bug found and fixed on the way: `zcash-sign` prints every randomizer
  before reading any signature, so the first version, which wrote each
  signature as soon as it was ready, could hand them back out of order when a
  payout spent two notes. They are now made and written strictly in order
  (`watcher/test/frost.test.ts` reproduces the race).

## Limits, said plainly

- **DKG ran on one machine.** The key is made by DKG, so no process ever
  holds the whole key, but in the demo all three holders' processes and
  `frostd` ran on the same laptop, and their share files sit side by side in
  one directory. A real launch puts each holder on their own machine.
- **One process signs.** `frost-sign2` holds two shares at once, and two of
  three shares are enough to rebuild the key, so for the length of a signing
  that process could. DKG removes the dealer, not this. With separate key
  holders, each runs `frost-client participant` against a `frostd` server.
- **Testnet only.** The viewing key keeps upstream's derivation, which is not
  quantum-recoverable under ZIP 2005.
- **Amounts are visible to the wallet.** FROST controls who can spend, not who
  can see: the watch-only launch wallet still sees each bid's amount arrive.

## Build

```
cargo build --release --manifest-path frost/zcash-sign-nu7/Cargo.toml
cargo build --release --manifest-path frost/frost-sign2/Cargo.toml
```

Each needs about 1 GB of free disk while compiling.
