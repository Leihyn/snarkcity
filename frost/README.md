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
- Key generation uses the Zcash Foundation's `frost-client trusted-dealer`.

## How a payout is signed

1. `zcash-devtool pczt create` and `pczt prove` build the payout from the
   watch-only wallet.
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
- The same day the Halo launch ran with FROST custody end to end: five sealed
  bids in, then five refunds and receipts out, each signed by two shares
  through `close-launch`. The public audit confirmed every refund paid.
- One bug found and fixed on the way: `zcash-sign` prints every randomizer
  before reading any signature, so the first version, which wrote each
  signature as soon as it was ready, could hand them back out of order when a
  payout spent two notes. They are now made and written strictly in order
  (`watcher/test/frost.test.ts` reproduces the race).

## Limits, said plainly

- **Trusted dealer.** One machine generates all three shares, so it saw the
  whole key. A real launch would use `frost-client dkg`, where no party ever
  holds it.
- **One process signs.** `frost-sign2` holds two shares at once. With separate
  key holders, each runs `frost-client participant` against a `frostd` server.
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
