// The claim dialog: load the bid file, choose where the tokens go, and let the
// relayer pay for a transaction this page checks and signs.

import { b64, readBidFile, recipientProblem, signClaim } from './claim.js';
import { explain, HttpError } from './errors.js';
import { tokens } from './view-model.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data.error);
  return data;
}

export function claimScreen() {
  const dialog = $('claim'), form = $('claimForm'), button = form.querySelector('button[type=submit]');
  let launch = null, bid = null;

  function say(text, { problem = false, html = false } = {}) {
    const out = $('claimStatus');
    out[html ? 'innerHTML' : 'textContent'] = text;
    out.classList.toggle('problem', problem);
  }

  // bid.status, once checked: what the chain says about this bid.
  function ready() {
    const problem = recipientProblem(form.recipient.value);
    const done = bid?.status?.status === 'claimed' || bid?.status?.status === 'no-allocation';
    button.disabled = !bid || !!problem || done;
    if (problem) say(problem, { problem: true });
    else if (bid) say(bidNote(bid), { html: true });
  }

  function bidNote(b) {
    const to = form.recipient.value.trim() ? '' : ` With no address, they go to ${esc(b.claimAddress)}, the key in your bid file.`;
    const s = b.status;
    if (!s) return `Bid ${esc(b.commitment.slice(0, 8))}… loaded.${to}`;
    if (s.status === 'no-allocation') return 'This bid has no tokens to claim: it lost, or arrived after the window. Its ZEC was refunded on Zcash.';
    if (s.status === 'claimed') {
      const link = s.signature ? ` <a href="https://explorer.solana.com/tx/${encodeURIComponent(s.signature)}?cluster=devnet" target="_blank" rel="noopener">See the claim transaction</a>.` : '';
      return `Already claimed: ${esc(tokens(s.tokens, launch.decimals))} tokens.${link}`;
    }
    return `Bid ${esc(b.commitment.slice(0, 8))}… won ${esc(tokens(s.tokens, launch.decimals))} tokens, not claimed yet.${to}`;
  }

  form.file.addEventListener('change', async () => {
    bid = null;
    const file = form.file.files[0];
    if (file) {
      const read = await readBidFile(await file.text());
      if (read.problem) say(read.problem, { problem: true });
      else if (read.launchId && read.launchId !== launch.launchId) say(`This bid file is for ${read.launchName}, not ${launch.name}.`, { problem: true });
      else bid = read;
    }
    if (bid || !file) ready(); else button.disabled = true;
    if (bid) await checkStatus(bid);
  });

  // Before anything is signed: has this bid anything to claim, and is it still
  // unclaimed? The question names only the bid's public fingerprint.
  async function checkStatus(loaded) {
    let status;
    try {
      status = await post('/api/claim/status', { launchId: launch.launchId, commitment: loaded.commitment });
    } catch (err) {
      if (bid === loaded) say(`${explain(err, "check this bid's status")} You can still try to claim.`, { problem: true });
      return;
    }
    if (bid !== loaded) return; // another file was chosen meanwhile
    loaded.status = status;
    ready();
  }

  form.recipient.addEventListener('input', ready);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      await claim(form.recipient.value.trim() || bid.claimAddress);
    } catch (err) {
      say(explain(err, 'claim the tokens'), { problem: true });
      button.disabled = false;
    }
  });

  async function claim(recipient) {
    say('Asking the relayer for the claim transaction…');
    const prepared = await post('/api/claim/prepare', {
      launchId: launch.launchId, commitment: bid.commitment, claimPubkey: bid.claimPubkey, salt: bid.salt, recipient,
    });
    if (prepared.status === 'no-allocation') return say('This bid has no tokens to claim: it lost, or arrived after the window. Its ZEC was refunded on Zcash.');
    if (prepared.status === 'claimed') return say('These tokens have already been claimed.');
    // Check against what the bidder chose, not what the relayer says it chose.
    const signed = await signClaim(bid, b64.decode(prepared.message), { programId: launch.programId, recipient, mint: launch.mint });
    if (signed.problem) throw new Error(signed.problem);
    say('Signed. Sending to Solana…');
    const { signature } = await post('/api/claim/submit', { message: prepared.message, signature: b64.encode(signed.signature) });
    const link = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
    say(`Claimed ${esc(tokens(prepared.tokens, launch.decimals))} tokens to ${esc(recipient)}. <a href="${link}" target="_blank" rel="noopener">See the transaction</a>`, { html: true });
  }

  dialog.addEventListener('close', () => { bid = null; launch = null; form.reset(); });

  return {
    open(status) {
      launch = status;
      bid = null;
      form.reset();
      $('claimName').textContent = status.name;
      say('');
      button.disabled = true;
      dialog.showModal();
    },
  };
}
