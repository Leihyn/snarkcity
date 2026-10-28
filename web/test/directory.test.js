import { test } from "node:test";
import assert from "node:assert/strict";
import { archivePlots, cityEntry, counts, launchFromHash, launchLink, listed, pickDowntown, visibleRange, ROW } from "../src/directory.js";

const e = (id, phase, extra = {}) => ({ id: String(id), name: `L${id}`, kind: "memecoin", phase, sold: 0, lit: 0, endHeight: 0, blocksLeft: 0, blocksToStart: 0, raisedZats: "0", sealed: true, frost: true, deposit: false, ...extra });

test("downtown holds the active launches first, then the newest, in creation order", () => {
  const all = [e(1, "live"), e(2, "no sale"), e(3, "live"), e(4, "bidding", { blocksLeft: 50 }), e(5, "lot", { blocksToStart: 9 }), e(6, "settling"), e(7, "bidding", { blocksLeft: 5 })];
  assert.deepEqual(pickDowntown(all, 4), ["4", "5", "6", "7"], "the four active launches, oldest plot first");
  assert.deepEqual(pickDowntown(all, 5), ["3", "4", "5", "6", "7"], "then the newest finished one");
  assert.deepEqual(pickDowntown(all.slice(0, 3), 12), ["1", "2", "3"], "few launches: all of them, unmoved");
});

test("the list filters by tab and name, and sorts", () => {
  const all = [e(1, "live", { raisedZats: "500" }), e(2, "bidding", { blocksLeft: 30 }), e(3, "bidding", { blocksLeft: 3 }), e(4, "live", { raisedZats: "9000", name: "Halo" })];
  assert.deepEqual(listed(all, { tab: "bidding" }).map((x) => x.id), ["3", "2"]);
  assert.deepEqual(listed(all, { q: "hal" }).map((x) => x.id), ["4"]);
  assert.deepEqual(listed(all, { sort: "raised" }).map((x) => x.id).slice(0, 2), ["4", "1"]);
  assert.deepEqual(listed(all, { sort: "newest" }).map((x) => x.id), ["4", "3", "2", "1"]);
  assert.deepEqual(listed(all, { sort: "ending" }).map((x) => x.id).slice(0, 2), ["3", "2"]);
  assert.deepEqual(counts(all), { all: 4, live: 2, bidding: 2 });
});

test("archive plots are stable: a new launch never moves an old one", () => {
  const before = archivePlots([e(10, "live"), e(20, "live"), e(30, "live")]);
  const after = archivePlots([e(10, "live"), e(20, "live"), e(30, "live"), e(40, "bidding")]);
  for (const id of ["10", "20", "30"]) assert.deepEqual(after.get(id), before.get(id));
  const many = archivePlots(Array.from({ length: 3000 }, (_, i) => e(1000 + i, "live")));
  const pts = [...many.values()];
  let closest = Infinity;
  for (let i = 0; i < pts.length; i += 7) for (let j = i + 1; j < Math.min(pts.length, i + 60); j++) closest = Math.min(closest, Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z));
  assert.ok(closest > 4, `plots stay apart (closest ${closest.toFixed(1)})`);
  assert.ok(pts.every((p) => p.r >= 85), "all outside the district");
});

test("an older server's full status maps to the same index entry", () => {
  const s = { launchId: "7", name: "Q", kind: "startup", phase: "live", supply: "2000", endHeight: 9, blocksLeft: 0, blocksToStart: 0,
    result: { tokensSold: "1500", raisedZats: "600001" }, solana: { allocated: "1500", claimed: "500" }, seal: { round: 1 }, custody: { kind: "frost" } };
  assert.deepEqual(cityEntry(s), { id: "7", name: "Q", kind: "startup", phase: "live", sold: 0.75, lit: 0.333, endHeight: 9, blocksLeft: 0, blocksToStart: 0, raisedZats: "600001", sealed: true, frost: true, deposit: false });
});

test("links and the visible window of a long list", () => {
  assert.equal(launchFromHash(launchLink("1792922955358")), "1792922955358");
  assert.equal(launchFromHash("#launch/abc"), null);
  assert.equal(launchFromHash(""), null);
  assert.deepEqual(visibleRange(0, 10 * ROW, 5000, 2), { first: 0, last: 12 });
  assert.deepEqual(visibleRange(1000 * ROW, 10 * ROW, 5000, 2), { first: 998, last: 1012 });
});
