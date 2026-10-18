import { test } from "node:test";
import assert from "node:assert/strict";
import { clearAuction, type Bid, type LaunchParams } from "../src/clearing.ts";

const bid = (txid: string, amountZats: bigint, maxPrice: bigint): Bid => ({
  txid,
  amountZats,
  maxPrice,
  commitment: txid.padEnd(64, "0"),
});

// decimals 0 keeps the arithmetic readable: 1 base unit = 1 token.
const simple = (supply: bigint, reservePrice = 1n): LaunchParams => ({ supply, decimals: 0, reservePrice });

const fillOf = (r: ReturnType<typeof clearAuction>, txid: string) => r.fills.find((f) => f.bid.txid === txid)!;

test("oversubscribed: marginal bid sets the price and is partly filled", () => {
  // Ranked by max price: a(10) b(8) c(5) d(2). a alone implies 600/100 = 6 <= 10.
  // Adding b implies 9 > 8, so b is marginal and the price is 8.
  // a gets 600/8 = 75; b gets the remaining 25 for 200 and is refunded 100.
  const r = clearAuction(
    [bid("a", 600n, 10n), bid("b", 300n, 8n), bid("c", 400n, 5n), bid("d", 200n, 2n)],
    simple(100n),
  );
  assert.deepEqual(r.price, { num: 8n, den: 1n });
  assert.deepEqual([fillOf(r, "a").tokens, fillOf(r, "a").costZats], [75n, 600n]);
  assert.deepEqual([fillOf(r, "b").tokens, fillOf(r, "b").costZats, fillOf(r, "b").refundZats], [25n, 200n, 100n]);
  assert.equal(fillOf(r, "c").refundZats, 400n);
  assert.equal(fillOf(r, "d").refundZats, 200n);
  assert.equal(r.tokensSold, 100n);
  assert.equal(r.raisedZats, 800n);
});

test("everyone fits: price is total budget over supply", () => {
  // 500 zats for 100 tokens -> 5 each. a gets 60, b gets 40.
  const r = clearAuction([bid("a", 300n, 10n), bid("b", 200n, 6n)], simple(100n));
  assert.deepEqual(r.price, { num: 500n, den: 100n });
  assert.equal(fillOf(r, "a").tokens, 60n);
  assert.equal(fillOf(r, "b").tokens, 40n);
  assert.equal(r.raisedZats, 500n);
});

test("undersubscribed: price falls back to the reserve and the rest stays unsold", () => {
  const r = clearAuction([bid("a", 300n, 20n)], simple(100n, 10n));
  assert.deepEqual(r.price, { num: 10n, den: 1n });
  assert.equal(fillOf(r, "a").tokens, 30n);
  assert.equal(r.tokensSold, 30n);
});

test("bids below the reserve are refunded and nothing sells", () => {
  const r = clearAuction([bid("a", 300n, 5n)], simple(100n, 10n));
  assert.equal(r.price, null);
  assert.equal(fillOf(r, "a").refundZats, 300n);
  assert.equal(r.tokensSold, 0n);
});

test("a bid that cannot beat the price set above it gets nothing", () => {
  // a alone buys the whole supply at 9; b's max is exactly 9, so b is out.
  const r = clearAuction([bid("a", 900n, 10n), bid("b", 300n, 9n)], simple(100n));
  assert.deepEqual(r.price, { num: 900n, den: 100n });
  assert.equal(fillOf(r, "a").tokens, 100n);
  assert.equal(fillOf(r, "b").tokens, 0n);
});

test("a single bid larger than the supply takes it all at its own max", () => {
  const r = clearAuction([bid("a", 5000n, 10n)], simple(100n));
  assert.deepEqual(r.price, { num: 10n, den: 1n });
  assert.deepEqual([fillOf(r, "a").tokens, fillOf(r, "a").costZats, fillOf(r, "a").refundZats], [100n, 1000n, 4000n]);
});

test("equal max prices are ordered by txid, so the result is deterministic", () => {
  const bids = [bid("b", 600n, 8n), bid("a", 600n, 8n)];
  const r1 = clearAuction(bids, simple(100n));
  const r2 = clearAuction([...bids].reverse(), simple(100n));
  assert.equal(fillOf(r1, "a").tokens, fillOf(r2, "a").tokens);
  assert.ok(fillOf(r1, "a").tokens >= fillOf(r1, "b").tokens);
});

test("random auctions keep every fairness rule", () => {
  let seed = 42;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let round = 0; round < 500; round++) {
    const params: LaunchParams = {
      supply: BigInt(1 + rand(10_000)) * 10n ** 6n,
      decimals: 6,
      reservePrice: BigInt(rand(50)),
    };
    const bids = Array.from({ length: 1 + rand(12) }, (_, i) =>
      bid(`t${round}-${i}`, BigInt(rand(2_000_000_000)), BigInt(1 + rand(100))),
    );
    const r = clearAuction(bids, params);
    assert.ok(r.tokensSold <= params.supply, "never sells more than the supply");
    for (const f of r.fills) {
      assert.equal(f.costZats + f.refundZats, f.bid.amountZats, "cost + refund = amount");
      assert.ok(f.refundZats >= 0n, "never charges more than the bid");
      if (!r.price) continue;
      const above = f.bid.maxPrice * r.price.den > r.price.num;
      const below = f.bid.maxPrice * r.price.den < r.price.num;
      if (below) assert.equal(f.tokens, 0n, "a bid below the price wins nothing");
      if (above && f.bid.amountZats > 0n) {
        const full = (f.bid.amountZats * 10n ** 6n * r.price.den) / r.price.num;
        assert.equal(f.tokens, full, "a bid above the price is filled in full");
      }
    }
  }
});
