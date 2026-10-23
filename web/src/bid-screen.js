// The bid dialog: terms -> save the bid file -> pay. The payment code only
// appears after the bid file is saved, because that file holds the only copy
// of the key the tokens are claimed with.

import { renderSVG } from 'uqr';
import { bidFile, bidFileName, bidMemo, checkBid, formatZec, makeClaimKey, paymentUri, timing } from './bid.js';
import { tokens, zec } from './view-model.js';

const $ = (id) => document.getElementById(id);
const STEPS = ['terms', 'save', 'pay'];

export function bidScreen() {
  const dialog = $('bid'), form = $('bidForm');
  let launch = null, draft = null; // draft: { key, bid, memo, uri }

  function step(name) {
    dialog.querySelectorAll('[data-step]').forEach((s) => { s.hidden = s.dataset.step !== name; });
    $('bidStep').textContent = `Step ${STEPS.indexOf(name) + 1} of 3`;
  }

  function showTiming() {
    const t = timing(launch);
    $('bidTiming').textContent = t.note;
    $('bidTiming').classList.toggle('late', !!t.late || !t.open);
    return t;
  }

  function showSummary() {
    const open = showTiming().open;
    const res = checkBid({ price: form.price.value, amount: form.amount.value, refundTo: form.refundTo.value }, launch);
    const out = $('bidSummary');
    if (res.problem) {
      out.textContent = form.price.value || form.amount.value ? res.problem : '';
      out.classList.add('problem');
    } else {
      out.textContent = `If you win in full you get at least ${tokens(res.tokensAtMax, launch.decimals)} tokens. Everyone pays the same clearing price, at most your ${formatZec(res.maxPrice)} ZEC per token; whatever is not spent comes back to your refund address.`;
      out.classList.remove('problem');
    }
    form.querySelector('button[type=submit]').disabled = !!res.problem || !open;
    return res;
  }

  form.addEventListener('input', showSummary);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const bid = showSummary();
    if (bid.problem || !timing(launch).open) return;
    const key = await makeClaimKey();
    const memo = bidMemo({ commitment: key.commitment, ...bid });
    draft = { key, bid, memo, uri: paymentUri(launch.bidAddress, bid.amountZats, memo) };
    $('bidCommit').textContent = key.commitment;
    step('save');
  });

  $('bidSave').addEventListener('click', () => {
    const file = bidFile(draft.key, launch, draft.bid, draft.memo);
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: bidFileName(launch, draft.key.commitment) });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showPayment();
  });

  function showPayment() {
    $('bidQr').innerHTML = renderSVG(draft.uri, { border: 2 });
    $('bidAddr').textContent = launch.bidAddress;
    $('bidAmount').textContent = `${formatZec(draft.bid.amountZats)} ZEC`;
    $('bidMemo').textContent = draft.memo;
    $('bidOpen').href = draft.uri;
    $('bidCli').textContent = `zcash-devtool wallet -w <your wallet> pay -i <identity> --payment-uri '${draft.uri}'`;
    showTiming();
    step('pay');
  }

  dialog.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy === 'uri' ? draft.uri : $(btn.dataset.copy).textContent;
    const label = btn.dataset.label ??= btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = label; }, 1500);
  });

  // Closing drops the key from memory. Before the file is saved nothing is
  // lost; after, the file has everything needed to pay and to claim.
  dialog.addEventListener('close', () => { draft = null; launch = null; });

  return {
    open(status) {
      launch = status;
      draft = null;
      form.reset();
      $('bidName').textContent = status.name;
      $('bidReserve').textContent = `${zec(status.reservePrice)} ZEC per token`;
      $('bidSupply').textContent = `${tokens(status.supply, status.decimals)} tokens`;
      step('terms');
      showSummary();
      dialog.showModal();
    },
    // Called on every poll so the block count and the late warning stay current.
    update(status) {
      if (!launch || status.launchId !== launch.launchId) return;
      launch = status;
      if (!$('bidForm').closest('[data-step]').hidden) showSummary(); else showTiming();
    },
  };
}
