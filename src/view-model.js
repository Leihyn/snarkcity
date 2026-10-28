// Pure helpers that turn a launch status (from /api/launches) into what the
// city shows. No three.js here, so they run under `node --test`.

export const MAX_FLOORS = 16;
export const MIN_FLOORS = 3;
const ZAT = 100_000_000;

// "0.0004" from 40000 zatoshis; trailing zeros trimmed.
export function zec(zats) {
  const n = Number(zats) / ZAT;
  return n.toFixed(8).replace(/\.?0+$/, "") || "0";
}

// Clearing price as ZEC per whole token. The engine keeps it as a fraction of
// zatoshis per token.
export function pricePerToken(price) {
  if (!price) return null;
  return zec(Number(price.num) / Number(price.den));
}

export function tokens(baseUnits, decimals) {
  const n = Number(baseUnits) / 10 ** decimals;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Height reflects how much of the supply sold; unknown (null) until final.
export function floorsFor(status) {
  if (status.phase !== "live" || !status.result) return 0;
  const sold = Number(status.result.tokensSold) / Number(status.supply);
  return Math.max(MIN_FLOORS, Math.round(MAX_FLOORS * Math.min(1, sold)));
}

// Lit windows follow claims: a fully claimed launch is fully lit.
export function litFraction(status) {
  const s = status.solana;
  if (!s || s.allocated === "0") return 0;
  return Math.min(1, Number(s.claimed) / Number(s.allocated));
}

export function signLines(status) {
  const name = status.name.toUpperCase();
  switch (status.phase) {
    case "lot": return [name, `SUPPLY LOCKED · OPENS IN ${status.blocksToStart} BLOCKS`];
    case "bidding": return [name, `SEALED BIDS · ${status.blocksLeft} BLOCKS LEFT`];
    case "settling": return [name, "SEALED · COUNTING"];
    case "no sale": return [name, "NO SALE · SUPPLY RETURNED"];
    case "live": {
      const pct = Math.round((100 * Number(status.result?.tokensSold ?? 0)) / Number(status.supply));
      return [name, `${pricePerToken(status.result?.price)} ZEC · ${pct}% SOLD`];
    }
    default: return [name, ""];
  }
}

export const PHASE_LABEL = {
  lot: "Supply locked",
  bidding: "Sealed bidding",
  settling: "Counting",
  "no sale": "No sale",
  live: "Live",
};

// A launch is only called sealed when its bids really are.
export function phaseLabel(status) {
  return status.phase === 'bidding' && !status.seal ? 'Bidding' : PHASE_LABEL[status.phase];
}
export const bidAction = (status) => (status.seal ? 'Place a sealed bid' : 'Place a bid');

// Fog phases hide the tower; the reveal plays when one of them gives way to "live".
export const FOGGY = new Set(["bidding", "settling"]);

// What a launch's bidders rely on, in plain words: whether prices were sealed,
// and who can move the money.
export function trustLines(status, nowSeconds, zone) {
  const lines = [];
  if (status.seal) {
    const at = moment(status.seal.revealAt, zone);
    lines.push(nowSeconds >= status.seal.revealAt
      ? `Bids sealed to drand round ${status.seal.round}, opened ${at}.`
      : `Bids sealed to drand round ${status.seal.round}: nobody can open them before ${at}.`);
  } else {
    lines.push("Bids not sealed: the launch wallet reads each bid's price as it arrives.");
  }
  if (status.deposit) lines.push(`Every bid pays the same ${zec(status.deposit)} ZEC deposit: the launch wallet sees how many bids came in, not their size.`);
  const c = status.custody;
  lines.push(c ? `Refunds need ${c.threshold} of ${c.holders} FROST key holders to sign.` : "Refunds are signed by a single operator key.");
  return lines;
}

// One way to write a moment everywhere: "26 Oct, 17:54 UTC", plus the viewer's
// own clock when it differs: "26 Oct, 17:54 UTC (18:54 your time)".
export function moment(seconds, zone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const at = new Date(seconds * 1000);
  const utc = clock(at, 'UTC'), local = clock(at, zone);
  const base = `${utc.day} ${utc.month}, ${utc.time} UTC`;
  if (local.day === utc.day && local.time === utc.time) return base;
  return `${base} (${local.day === utc.day ? '' : `${local.day} ${local.month}, `}${local.time} your time)`;
}

function clock(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: p.day, month: p.month, time: `${p.hour}:${p.minute}` };
}
