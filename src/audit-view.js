// Turns an audit report (relayer/src/audit-launch.ts) into what the audit
// page shows. No DOM, so it runs under `node --test`.

import { pricePerToken, tokens, zec } from './view-model.js';

// One sentence that says whether the published result holds up, and if not, where.
export function verdict(report) {
  if (report.ok) return { ok: true, text: 'The result checks out. Re-running the auction from the Zcash chain gives the same result Solana holds, and every refund was paid.' };
  const why = [];
  if (!report.onChain.finalized) why.push('no result is final on Solana yet');
  if (!report.rootMatches) why.push('the allocation on Solana differs from the auction re-run from Zcash');
  if (!report.onChain.allocatedMatches) why.push('the tokens allocated on Solana differ from the tokens sold');
  if (!report.onChain.supplyMatches) why.push('the token or supply on Solana differs from the terms');
  const unpaid = report.payouts.filter((p) => p.status !== 'paid' && p.status !== 'no address');
  if (unpaid.length) why.push(`${unpaid.length} refund${unpaid.length === 1 ? ' is' : 's are'} not paid in full (${[...new Set(unpaid.map((p) => p.status))].join(', ')})`);
  return { ok: false, text: `Does not check out: ${why.join('; ') || 'see the report'}.` };
}

export function auditRows(report, decimals) {
  const paid = report.payouts.filter((p) => p.status === 'paid').length;
  const yes = (b) => (b ? 'Yes' : 'No');
  return [
    ['Bids counted', String(report.bids)],
    ['Not counted (late, or no bid memo)', String(report.rejected)],
    ['Clearing price', report.price ? `${pricePerToken(report.price)} ZEC / token` : 'None (nothing sold)'],
    ['Tokens sold', `${tokens(report.tokensSold, decimals)}`],
    ['ZEC raised', `${zec(report.raisedZats)} ZEC`],
    ['Refunds paid', report.payouts.length ? `${paid} of ${report.payouts.length}` : 'None owed'],
    ['Matches the allocation on Solana', yes(report.rootMatches)],
    ['Tokens allocated on Solana match', yes(report.onChain.allocatedMatches)],
    ['Token and supply match the terms', yes(report.onChain.supplyMatches)],
  ];
}

// The same audit, run from a checkout of the repo with the two downloaded files.
export function auditCommand(files) {
  return `node relayer/scripts/audit-launch.ts ${files.terms} ${files.viewKey} ./audit-wallet <path to zcash-devtool>`;
}

// The opened bids for the results table: highest price first, each with what
// it offered and what happened to it. Outcome follows the clearing price:
// above it wins in full, at it is the marginal bid, below it loses.
export function envelopeRows(report, decimals) {
  const price = report.price ? Number(report.price.num) / Number(report.price.den) : null;
  return (report.envelopes ?? []).map((e) => {
    const p = Number(e.maxPrice);
    // On a fixed-deposit launch the unused part of the deposit always comes
    // back; only a refund beyond that means the bid was partly filled.
    const unused = e.budgetZats !== undefined ? BigInt(e.amountZats) - BigInt(e.budgetZats) : 0n;
    const outcome = e.late ? 'late'
      : price === null || BigInt(e.tokens) === 0n ? 'lost'
      : p > price || BigInt(e.refundZats) - unused === 0n ? 'won' : 'partial';
    return {
      outcome,
      label: { won: 'Won', partial: 'Partial', lost: 'Lost', late: 'Late' }[outcome],
      maxPrice: `${zec(e.maxPrice)} ZEC`,
      amount: `${zec(e.amountZats)} ZEC${e.budgetZats !== undefined ? ` (budget ${zec(e.budgetZats)})` : ''}`,
      tokens: BigInt(e.tokens) > 0n ? tokens(e.tokens, decimals) : '-',
      refund: BigInt(e.refundZats) > 0n ? `${zec(e.refundZats)} ZEC` : '-',
    };
  });
}

// Each refund the audit expected, linked to the Zcash transaction
// that paid it (also when that payment was wrong, so you can see it).
export const ZCASH_TX = 'https://blockexplorer.one/zcash/testnet/tx/';
export function payoutRows(report) {
  return report.payouts.map((p) => ({
    owed: `${zec(p.owedZats)} ZEC`,
    status: p.status,
    ok: p.status === 'paid' || p.status === 'no address',
    tx: p.txid ? { short: `${p.txid.slice(0, 8)}…`, href: ZCASH_TX + p.txid } : null,
  }));
}
