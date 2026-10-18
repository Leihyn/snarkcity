// Uniform-price sealed-bid auction.
//
// Each bid is a ZEC budget plus a maximum price per whole token. The clearing
// price is the lowest price at which demand fits the supply. Everyone who wins
// pays that same price; the marginal bid may be partly filled; every other bid
// is refunded in full. All arithmetic is integer (zatoshis, token base units).

export interface Bid {
  txid: string;
  amountZats: bigint;
  commitment: string;
  maxPrice: bigint; // zatoshis per whole token
  refundTo?: string;
}

export interface LaunchParams {
  supply: bigint; // token base units for sale
  decimals: number;
  reservePrice: bigint; // zatoshis per whole token
}

// Price in zatoshis per whole token, kept as a fraction so nothing is rounded early.
export interface Price {
  num: bigint;
  den: bigint;
}

export interface Fill {
  bid: Bid;
  tokens: bigint;
  costZats: bigint;
  refundZats: bigint;
}

export interface ClearingResult {
  price: Price | null; // null when nothing sold
  fills: Fill[]; // one per bid, in input order
  tokensSold: bigint;
  raisedZats: bigint;
}

export function clearAuction(bids: Bid[], params: LaunchParams): ClearingResult {
  const unit = 10n ** BigInt(params.decimals);
  const ranked = rankEligible(bids, params.reservePrice);
  const { price, fullCount, marginal } = findPrice(ranked, params, unit);
  const tokens = new Map<Bid, bigint>();
  if (price) {
    let sold = 0n;
    for (const bid of ranked.slice(0, fullCount)) {
      const t = tokensFor(bid.amountZats, price, unit);
      tokens.set(bid, t);
      sold += t;
    }
    if (marginal) {
      const bid = ranked[fullCount];
      tokens.set(bid, min(params.supply - sold, tokensFor(bid.amountZats, price, unit)));
    }
  }
  return summarize(bids, tokens, price, unit);
}

function rankEligible(bids: Bid[], reserve: bigint): Bid[] {
  return bids
    .filter((b) => b.amountZats > 0n && b.maxPrice >= reserve)
    .sort((a, b) =>
      a.maxPrice === b.maxPrice ? (a.txid < b.txid ? -1 : 1) : a.maxPrice > b.maxPrice ? -1 : 1,
    );
}

// Walk bids from the highest max price down, adding budgets while the implied
// price (total budget / supply) stays within every included bid's maximum.
function findPrice(ranked: Bid[], p: LaunchParams, unit: bigint) {
  let total = 0n;
  let fullCount = 0;
  for (const bid of ranked) {
    if ((total + bid.amountZats) * unit > bid.maxPrice * p.supply) break;
    total += bid.amountZats;
    fullCount++;
  }
  if (ranked.length === 0) return { price: null, fullCount, marginal: false };
  const next = ranked[fullCount];
  // The next bid would push the price past its own maximum. If it can still
  // afford the price set by the bids above it, it becomes the marginal bid and
  // sets the price at its maximum; otherwise it is simply out.
  if (next && total * unit < next.maxPrice * p.supply) {
    return { price: { num: next.maxPrice, den: 1n }, fullCount, marginal: true };
  }
  if (total * unit >= p.reservePrice * p.supply) {
    return { price: { num: total * unit, den: p.supply }, fullCount, marginal: false };
  }
  return { price: { num: p.reservePrice, den: 1n }, fullCount, marginal: false };
}

function tokensFor(budget: bigint, price: Price, unit: bigint): bigint {
  return (budget * unit * price.den) / price.num;
}

function costOf(tokens: bigint, price: Price, unit: bigint): bigint {
  return ceilDiv(tokens * price.num, unit * price.den);
}

function summarize(bids: Bid[], tokens: Map<Bid, bigint>, price: Price | null, unit: bigint) {
  let tokensSold = 0n;
  let raisedZats = 0n;
  const fills = bids.map((bid) => {
    const t = tokens.get(bid) ?? 0n;
    const costZats = price && t > 0n ? costOf(t, price, unit) : 0n;
    tokensSold += t;
    raisedZats += costZats;
    return { bid, tokens: t, costZats, refundZats: bid.amountZats - costZats };
  });
  return { price, fills, tokensSold, raisedZats };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
