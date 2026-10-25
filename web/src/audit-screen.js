// The audit dialog: shows the last public audit of a launch, its viewing key,
// and how to run the same check yourself. Polls while an audit is running.

import { auditCommand, auditRows, envelopeRows, verdict } from './audit-view.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const POLL_MS = 4_000;

export function auditScreen() {
  const dialog = $('audit');
  let launch = null, timer = null;

  async function load(method = 'GET') {
    const res = await fetch(`/api/audit/${encodeURIComponent(launch.launchId)}`, { method, cache: 'no-store' });
    if (!res.ok) throw new Error(`server error ${res.status}`);
    return res.json();
  }

  function setVerdict(text, cls) {
    $('auditVerdict').textContent = text;
    $('auditVerdict').className = `audit-verdict ${cls}`;
  }

  function show(v) {
    if (!v.viewingKey) setVerdict('No viewing key yet: it is published once the result is final on Solana.', '');
    else if (v.running) setVerdict('Checking: syncing a watch-only wallet from the viewing key and re-running the auction. A first check can take several minutes.', '');
    else if (v.error) setVerdict(`The check could not finish: ${v.error}`, 'bad');
    else if (v.report) { const r = verdict(v.report); setVerdict(r.text, r.ok ? 'ok' : 'bad'); }
    $('auditRows').innerHTML = v.report ? auditRows(v.report, launch.decimals).map(([k, x]) => `<div class="row"><dt>${esc(k)}</dt><dd>${esc(x)}</dd></div>`).join('') : '';
    showEnvelopes(v.report);
    $('auditWhen').textContent = v.checkedAt ? `Last checked ${new Date(v.checkedAt).toLocaleString()}.` : '';
    $('auditRerun').disabled = !v.viewingKey || v.running;
    $('auditKey').textContent = v.viewingKey ?? 'Not published yet.';
    const base = `/api/audit/${encodeURIComponent(launch.launchId)}`;
    $('auditTerms').href = `${base}/terms.json`;
    $('auditKeyFile').href = `${base}/viewkey.txt`;
    $('auditKeyFile').hidden = $('auditCopy').hidden = !v.viewingKey;
    $('auditCmd').textContent = auditCommand(v.files);
    clearTimeout(timer);
    if (v.running && dialog.open) timer = setTimeout(() => refresh(), POLL_MS);
  }

  function showEnvelopes(report) {
    const rows = report ? envelopeRows(report, launch.decimals) : [];
    $('auditEnvelopes').hidden = rows.length === 0;
    $('auditBids').innerHTML = rows.map((r) => `<tr class="${r.outcome}"><td>${esc(r.maxPrice)}</td><td>${esc(r.amount)}</td><td>${esc(r.tokens)}</td><td>${esc(r.refund)}</td><td>${esc(r.label)}</td></tr>`).join('');
  }

  async function refresh(method) {
    try { show(await load(method)); } catch (e) { setVerdict(`Could not load the audit: ${e.message}`, 'bad'); }
  }

  $('auditRerun').addEventListener('click', () => refresh('POST'));
  $('auditCopy').addEventListener('click', async () => {
    const b = $('auditCopy');
    try { await navigator.clipboard.writeText($('auditKey').textContent); b.textContent = 'Copied'; } catch { b.textContent = 'Copy failed'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
  dialog.addEventListener('close', () => { clearTimeout(timer); launch = null; });

  return {
    open(status) {
      launch = status;
      $('auditName').textContent = status.name;
      setVerdict('Loading…', '');
      $('auditRows').innerHTML = '';
      dialog.showModal();
      refresh();
    },
  };
}
