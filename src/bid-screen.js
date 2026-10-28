// The bid dialog: terms -> save the bid file -> pay. The payment code only
// appears after the bid file is saved, because that file holds the only copy
// of the key the tokens are claimed with. A saved bid can be paid later: on
// reopening, or from its file.

import { renderSVG } from 'uqr';
import { bidFile, bidFileName, bidMemo, checkBid, formatZec, makeClaimKey, paymentUri, priceEcho, priceBoth, resumeBid, timing } from './bid.js';
import { DRAND, sealBid } from './seal.js';
import { moment, tokens } from './view-model.js';

const $ = (id) => document.getElementById(id);
const STEPS = ['terms', 'save', 'pay'];

export function bidScreen() {
  const dialog = $('bid'), form = $('bidForm');
  let launch = null, draft = null; // draft: { key?, amountZats, memo, uri, commitment }
  // Bids whose file was saved but maybe not paid, by launch: only what paying
  // needs. The claim key stays in the file, not here.
  const saved = new Map();

  function step(name) {
    dialog.querySelectorAll('[data-step]').forEach((s) => { s.hidden = s.dataset.step !== name; });
    $('bidStep').textContent = `Step ${STEPS.indexOf(name) + 1} of 3`;
  }

  function showTiming() {
    const t = timing(launch);
    // A snapshot's block counts stop when it was taken.
    $('bidTiming').textContent = document.body.hasAttribute('data-snapshot') ? `${t.note} Block counts are as of the snapshot.` : t.note;
    $('bidTiming').classList.toggle('late', !!t.late || !t.open);
    $('bidLanding').textContent = `It counts if it is mined by block ${launch.endHeight.toLocaleString('en-US')}. The chain is at block ${launch.zcashTip.toLocaleString('en-US')} now${launch.phase === 'bidding' ? `, ${launch.blocksLeft} to go` : ''}.`;
    return t;
  }

  function showSummary() {
    const open = showTiming().open;
    const priceUnit = form.priceUnit.value;
    $('bidEcho').textContent = priceEcho(form.price.value, priceUnit);
    form.price.placeholder = priceUnit === 'zats' ? '400' : '0.000004';
    const res = checkBid({ price: form.price.value, priceUnit, amount: form.amount.value, refundTo: form.refundTo.value }, launch);
    const out = $('bidSummary');
    if (res.problem) {
      out.textContent = form.price.value || form.amount.value ? res.problem : '';
      out.classList.add('problem');
    } else {
      out.textContent = `If you win in full you get at least ${tokens(res.tokensAtMax, launch.decimals)} tokens. Everyone pays the same clearing price, at most your ${priceBoth(res.maxPrice)} per token; whatever is not spent comes back to your refund address.`;
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
    const memo = await memoFor(key, bid);
    if (!memo) return;
    draft = { key, bid, amountZats: bid.amountZats, memo, commitment: key.commitment, uri: paymentUri(launch.bidAddress, bid.amountZats, memo) };
    $('bidCommit').textContent = key.commitment;
    step('save');
  });

  // Sealed launches: the bid is time-locked to drand, so only the pinned drand
  // network's round can open it. Anything else in the terms is refused.
  async function memoFor(key, bid) {
    if (!launch.seal) return bidMemo({ commitment: key.commitment, ...bid });
    if (launch.seal.chainHash !== DRAND.chainHash) {
      $('bidSummary').textContent = 'This launch names an unknown seal, so this page will not seal a bid to it.';
      $('bidSummary').classList.add('problem');
      return null;
    }
    return sealBid({ commitment: key.commitment, maxPrice: bid.maxPrice, budget: bid.budgetZats, refundTo: bid.refundTo }, launch.seal.round);
  }

  $('bidSave').addEventListener('click', () => {
    const file = bidFile(draft.key, launch, draft.bid, draft.memo);
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const name = bidFileName(launch, draft.key.commitment);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const { amountZats, memo, uri, commitment } = draft;
    saved.set(launch.launchId, { amountZats, memo, uri, commitment, name });
    showPayment();
  });

  // Paying a bid saved earlier, from the file the bidder kept.
  $('bidResume').addEventListener('click', () => $('bidResumeFile').click());
  $('bidResumeFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const back = resumeBid(await file.text(), launch);
    if (back.problem) { $('bidResumeNote').textContent = back.problem; return; }
    draft = back;
    showPayment(`Paying the bid saved in ${file.name}.`);
  });
  $('bidRestart').addEventListener('click', () => {
    saved.delete(launch.launchId);
    draft = null;
    form.reset();
    showSummary();
    step('terms');
  });

  function showPayment(resumedNote) {
    $('bidResumed').hidden = !resumedNote;
    $('bidResumed').textContent = resumedNote ?? '';
    $('bidRestart').hidden = !resumedNote;
    dialog.classList.remove('show-qr');
    $('bidQr').innerHTML = renderSVG(draft.uri, { border: 2 });
    $('bidAddr').textContent = launch.bidAddress;
    $('bidAmount').textContent = `${formatZec(draft.amountZats)} ZEC`;
    const sealed = typeof draft.memo !== 'string';
    $('bidMemo').textContent = sealed
      ? `Sealed bid, ${draft.memo.length} bytes. It opens at ${moment(launch.seal.revealAt)}; until then nobody can read it, SnarkCity included. It travels only in the payment link.`
      : draft.memo;
    $('bidMemo').classList.toggle('prose', sealed);
    dialog.querySelector('[data-copy="bidMemo"]').hidden = sealed;
    $('bidOpen').href = draft.uri;
    $('bidCli').textContent = `zcash-devtool wallet -w <your wallet> pay -i <identity> --payment-uri '${draft.uri}'`;
    showTiming();
    step('pay');
  }

  // Phones cannot scan their own screen: the QR is for another device.
  $('bidShowQr').addEventListener('click', () => dialog.classList.toggle('show-qr'));

  dialog.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy === 'uri' ? draft.uri : $(btn.dataset.copy).textContent;
    const label = btn.dataset.label ??= btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = label; }, 1500);
  });

  // Closing drops the claim key from memory: the saved file has it.
  dialog.addEventListener('close', () => { draft = null; launch = null; });

  return {
    open(status) {
      launch = status;
      draft = null;
      form.reset();
      $('bidResumeNote').textContent = '';
      $('bidName').textContent = status.name;
      $('bidKind').textContent = status.seal ? 'Sealed bid' : 'Bid';
      $('bidReserve').textContent = `${priceBoth(BigInt(status.reservePrice))} per token`;
      $('bidSupply').textContent = `${tokens(status.supply, status.decimals)} tokens`;
      $('bidSealed').hidden = !status.seal;
      const deposit = status.deposit ? formatZec(BigInt(status.deposit)) : null;
      $('bidAmountLabel').textContent = deposit ? 'Your budget' : 'Amount to send';
      $('bidAmountHint').textContent = deposit ? `ZEC, at most the ${deposit} ZEC deposit` : 'ZEC';
      if (status.seal) $('bidSealed').textContent = deposit
        ? `Sealed with drand: your price, budget, refund address and claim-key fingerprint stay encrypted until ${moment(status.seal.revealAt)}, when the drand network publishes the key. Every bid on this launch sends the same ${deposit} ZEC deposit, so the launch wallet learns only how many bids came in, not how large they are. Whatever your budget does not spend comes back.`
        : `Sealed with drand: your price, refund address and claim-key fingerprint stay encrypted until ${moment(status.seal.revealAt)}, when the drand network publishes the key. Nobody can read them before then, SnarkCity included. The amount you send is not sealed: the launch wallet sees it arrive.`;
      const kept = saved.get(status.launchId);
      if (kept) {
        draft = kept;
        showPayment(`You saved ${kept.name} for this launch. Pay it below, or start a new bid.`);
      } else {
        step('terms');
        showSummary();
      }
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
