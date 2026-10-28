// The city's directory of launches, for any number of them: which ones stand
// downtown, where the rest stand in the archive, and what the list shows.
// Works on the light index from /api/city (see .claude/work/scale-contract.md).
// No DOM, no three.js, so it runs under `node --test`.

export const DOWNTOWN = 12; // building plots around the plaza (city.js SLOTS)

// Active launches first: they are where fog, reveals and bids happen.
const ACTIVE = { bidding: 0, settling: 1, lot: 2 };

// The index entry for one full launch status (what /api/city serves), so an
// older server that only has /api/launches still works.
export function cityEntry(s) {
  const live = s.phase === 'live' && s.result;
  const allocated = Number(s.solana?.allocated ?? 0);
  const round3 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
  return {
    id: s.launchId, name: s.name, kind: s.kind, phase: s.phase,
    sold: live ? round3(Number(s.result.tokensSold) / Number(s.supply)) : 0,
    lit: allocated > 0 ? round3(Number(s.solana.claimed) / allocated) : 0,
    endHeight: s.endHeight, blocksLeft: s.blocksLeft, blocksToStart: s.blocksToStart,
    raisedZats: live ? String(s.result.raisedZats) : '0',
    sealed: !!s.seal, frost: !!s.custody, deposit: !!s.deposit,
  };
}

const newestFirst = (a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0);
function byRelevance(a, b) {
  const ra = ACTIVE[a.phase] ?? 3, rb = ACTIVE[b.phase] ?? 3;
  if (ra !== rb) return ra - rb;
  if (a.phase === 'bidding' || a.phase === 'settling') return a.blocksLeft - b.blocksLeft || newestFirst(a, b);
  if (a.phase === 'lot') return a.blocksToStart - b.blocksToStart || newestFirst(a, b);
  return newestFirst(a, b);
}

// The launches that stand downtown: active ones first, then the newest. They
// keep the order they were created in, so their plots do not shuffle.
export function pickDowntown(entries, n = DOWNTOWN) {
  return [...entries].sort(byRelevance).slice(0, n).sort((a, b) => -newestFirst(a, b)).map((e) => e.id);
}

export const TABS = [
  ['all', 'All'], ['bidding', 'Bidding'], ['lot', 'Opening soon'], ['settling', 'Counting'], ['live', 'Live'], ['no sale', 'No sale'],
];
export const SORTS = [['relevant', 'Most relevant'], ['ending', 'Ending soonest'], ['newest', 'Newest'], ['raised', 'Most raised']];

export function counts(entries) {
  const c = { all: entries.length };
  for (const e of entries) c[e.phase] = (c[e.phase] ?? 0) + 1;
  return c;
}

// What the list shows: one tab, a name search, one order.
export function listed(entries, { tab = 'all', q = '', sort = 'relevant' } = {}) {
  const query = q.trim().toLowerCase();
  const rows = entries.filter((e) => (tab === 'all' || e.phase === tab) && (!query || e.name.toLowerCase().includes(query)));
  const order = {
    relevant: byRelevance,
    newest: newestFirst,
    raised: (a, b) => (BigInt(b.raisedZats) > BigInt(a.raisedZats) ? 1 : BigInt(b.raisedZats) < BigInt(a.raisedZats) ? -1 : newestFirst(a, b)),
    // Open launches by blocks left; the rest after them, newest first.
    ending: (a, b) => {
      const open = (e) => (e.phase === 'bidding' ? e.blocksLeft : e.phase === 'lot' ? e.blocksToStart + 1e9 : Infinity);
      return open(a) - open(b) || newestFirst(a, b);
    },
  }[sort] ?? byRelevance;
  return rows.sort(order);
}

// Archive plots on a sunflower spiral outside the district. A launch's plot is
// its rank by creation (its id), so new launches only add plots at the edge
// and no building ever moves.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export const ARCHIVE_START = 85, ARCHIVE_SPACING = 6.2;
export function archivePlot(rank) {
  const r = ARCHIVE_START + ARCHIVE_SPACING * Math.sqrt(rank);
  return { x: Math.cos(rank * GOLDEN) * r, z: Math.sin(rank * GOLDEN) * r, r };
}
export function archivePlots(entries) {
  const ranked = [...entries].sort((a, b) => -newestFirst(a, b));
  return new Map(ranked.map((e, i) => [e.id, archivePlot(i)]));
}

// "#launch/<id>": a link that opens the city on one launch.
export const launchLink = (id) => `#launch/${id}`;
export function launchFromHash(hash) {
  const m = /^#launch\/(\d{1,20})$/.exec(hash ?? '');
  return m ? m[1] : null;
}

// One list row's height in pixels; the list draws only the rows in view.
export const ROW = 48;
export function visibleRange(scrollTop, height, total, overscan = 6) {
  const first = Math.max(0, Math.floor(scrollTop / ROW) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW) + overscan);
  return { first, last };
}
