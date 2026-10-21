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

// Fog phases hide the tower; the reveal plays when one of them gives way to "live".
export const FOGGY = new Set(["bidding", "settling"]);
