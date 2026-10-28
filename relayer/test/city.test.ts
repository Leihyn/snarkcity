import { test } from "node:test";
import assert from "node:assert/strict";
import anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { auditOnStart } from "../src/auditor.ts";
import { fetchLaunches, launchPda, program } from "../src/client.ts";
import type { PublicTerms } from "../src/launch-file.ts";
import { cityEntry, launchStatus } from "../src/status.ts";

const terms: PublicTerms = {
  name: "Halo", kind: "memecoin", bidAddress: "utest1x", startHeight: 100, endHeight: 120,
  supply: "3000", decimals: 6, reservePrice: "100", programId: "p", rpc: "r", mint: "m", creator: "c", launchId: "1792922955358",
};
const chain = (finalized: boolean, allocated: bigint, claimed: bigint, noSale = false) => ({
  creator: "c", mint: "m", supply: 3000n, root: finalized && !noSale ? "aa" : null, noSale, finalized, allocated, claimed, unsoldWithdrawn: false,
});
const settlement = { price: { num: "1", den: "1" }, tokensSold: "2000", raisedZats: "600001", bids: 3 };

test("a live launch's city entry shows the share sold and claimed", () => {
  const e = cityEntry(launchStatus(terms, 130, chain(true, 2000n, 1000n), settlement));
  assert.deepEqual(e, {
    id: "1792922955358", name: "Halo", kind: "memecoin", phase: "live", sold: 0.667, lit: 0.5,
    endHeight: 120, blocksLeft: 0, blocksToStart: 0, raisedZats: "600001", sealed: false, frost: false, deposit: false,
  });
});

test("nothing sold or raised shows until the result is final", () => {
  const settling = cityEntry(launchStatus(terms, 125, chain(false, 0n, 0n), settlement));
  assert.equal(settling.phase, "settling");
  assert.deepEqual([settling.sold, settling.lit, settling.raisedZats], [0, 0, "0"], "nothing allocated is not a division by zero");
  const lot = cityEntry(launchStatus(terms, 90, null, null));
  assert.deepEqual([lot.phase, lot.blocksToStart, lot.sold, lot.lit, lot.raisedZats], ["lot", 10, 0, 0, "0"]);
});

test("the city entry flags sealed, FROST and deposit launches", () => {
  const t = { ...terms, deposit: "50000", seal: { round: 1, revealAt: 2, chainHash: "h" }, custody: { kind: "frost" as const, threshold: 2, holders: 3 } };
  const e = cityEntry(launchStatus(t, 110, null, null));
  assert.deepEqual([e.phase, e.sealed, e.frost, e.deposit, e.blocksLeft], ["bidding", true, true, true, 10]);
});

test("shares round to 3 decimals and never pass 1", () => {
  const big = { ...terms, supply: (10n ** 30n).toString() };
  const sold = { ...settlement, tokensSold: (10n ** 30n / 3n).toString() };
  assert.equal(cityEntry(launchStatus(big, 130, chain(true, 3n, 7n), sold)).sold, 0.333);
  assert.equal(cityEntry(launchStatus(big, 130, chain(true, 3n, 7n), sold)).lit, 1);
});

// Stands in for the Solana RPC: serves encoded launch accounts by address and
// records how many keys each call asked for.
async function fakeConnection(accounts: Map<string, Buffer>) {
  const calls: number[] = [];
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.push(keys.length);
      return keys.map((k) => (accounts.has(k.toBase58()) ? { data: accounts.get(k.toBase58())! } : null));
    },
  };
  return { conn: conn as unknown as Connection, calls };
}

test("launch accounts are read in batches of at most 100 and decoded in order", async () => {
  const coder = program({} as Connection, Keypair.generate()).coder.accounts;
  const creator = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const launches = Array.from({ length: 250 }, (_, i) => ({ creator: creator.toBase58(), launchId: String(1000 + i) }));
  const accounts = new Map<string, Buffer>();
  for (const [i, l] of launches.entries()) {
    if (i % 50 === 7) continue; // not created yet
    const root = i % 2 ? Array(32).fill(0) : Array(32).fill(i % 4 === 0 ? 0xff : 0xab);
    const data = await coder.encode("launch", {
      creator, mint, launchId: new anchor.BN(l.launchId), supply: new anchor.BN(1000 + i), root, allocated: new anchor.BN(i), claimed: new anchor.BN(1), unsoldWithdrawn: false, bump: 255,
    });
    accounts.set(launchPda(creator, BigInt(l.launchId)).toBase58(), data);
  }
  const { conn, calls } = await fakeConnection(accounts);
  const states = await fetchLaunches(conn, launches);
  assert.deepEqual(calls, [100, 100, 50]);
  assert.equal(states.length, 250);
  assert.equal(states[7], null);
  assert.equal(states[57], null);
  assert.deepEqual(
    [states[1]!.finalized, states[2]!.finalized, states[2]!.root, states[4]!.noSale, states[4]!.root],
    [false, true, "ab".repeat(32), true, null],
  );
  assert.deepEqual([states[249]!.supply, states[249]!.allocated, states[249]!.mint], [1249n, 249n, mint.toBase58()]);
});

test("server start re-checks only audits that failed or predate the result", () => {
  assert.equal(auditOnStart({ ok: true }, true), false, "a passed audit of a final launch is kept");
  assert.equal(auditOnStart({ ok: true }, false), true);
  assert.equal(auditOnStart({ ok: false }, true), true);
  assert.equal(auditOnStart(null, true), false, "never audited: waits to be asked");
});
