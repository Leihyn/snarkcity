// The claim dialog: load the bid file, choose where the tokens go, and let the
// relayer pay for a transaction this page checks and signs.

import { b64, readBidFile, recipientProblem, signClaim } from './claim.js';
import { tokens } from './view-model.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `server error ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `server error ${res.status}`);
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

  function ready() {
    const problem = recipientProblem(form.recipient.value);
    button.disabled = !bid || !!problem;
    if (problem) say(problem, { problem: true });
    else if (bid) say(`Bid ${bid.commitment.slice(0, 8)}… loaded.${form.recipient.value.trim() ? '' : ` With no address, the tokens go to ${bid.claimAddress}, the key in your bid file.`}`);
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
  });
  form.recipient.addEventListener('input', ready);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      await claim(form.recipient.value.trim() || bid.claimAddress);
    } catch (err) {
      say(err.message, { problem: true });
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
