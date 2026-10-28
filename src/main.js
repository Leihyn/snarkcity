import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadAll } from './assets.js';
import { buildDistrict, SLOTS, VIEW } from './city.js';
import { bidScreen } from './bid-screen.js';
import { auditScreen } from './audit-screen.js';
import { claimScreen } from './claim-screen.js';
import { buildSite } from './site.js';
import { buildArchive } from './archive.js';
import { archivePlots, cityEntry, counts, launchFromHash, launchLink, listed, pickDowntown, ROW, SORTS, TABS, visibleRange } from './directory.js';
import { hash } from './rng.js';
import { bidAction, litFraction, moment, phaseLabel, pricePerToken, tokens, trustLines, zec } from './view-model.js';
import { explain, HttpError } from './errors.js';
import { loadTheme } from './theme.js';

const T = await loadTheme();

const POLL_MS = 15_000;
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(T.sky);
scene.fog = new THREE.Fog(T.sky, T.fogNear, T.fogFar);
const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 900);
camera.position.set(...VIEW);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 12, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 25;
controls.maxDistance = 260;
const labels = new CSS2DRenderer();
labels.domElement.className = 'labels';
document.getElementById('app').appendChild(labels.domElement);

scene.add(new THREE.HemisphereLight(T.hemiSky, T.hemiGround, T.hemi));
const sun = new THREE.DirectionalLight(T.sun, T.sunIntensity);
sun.position.set(-60, 110, 50);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, far: 320 });
scene.add(sun);

const sites = new Map(); // launchId -> { site, status, chip }: the downtown buildings
let index = []; // every launch, light (directory.js cityEntry)
const details = new Map(); // launchId -> full status, for downtown and the selected launch
let district = null, archive = null, plots = new Map();
let selected = null;
let filter = { tab: 'all', q: '', sort: 'relevant' };
const bid = bidScreen();
const claim = claimScreen();
const auditView = auditScreen();

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  renderer.setSize(w, h, false);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function getJson(path) {
  // no-cache: revalidate every time, so an unchanged index costs a 304.
  const res = await fetch(path, { cache: 'no-cache', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new HttpError(res.status);
  return res.json();
}

// The light index of every launch. An older server or snapshot has only the
// full list; then that list is the index and every launch's details.
let fullList = false;
async function fetchIndex() {
  if (!fullList) {
    try { return await getJson('api/city'); } catch (e) { if (e.status !== 404) throw e; fullList = true; }
  }
  const data = await getJson('api/launches');
  for (const s of data.launches) details.set(s.launchId, s);
  return { ...data, launches: data.launches.map(cityEntry) };
}

async function fetchDetails(id) {
  if (fullList) return details.get(id) ?? null;
  const s = await getJson(`api/launch/${encodeURIComponent(id)}`);
  details.set(id, s);
  return s;
}

function addSite(status, index) {
  const site = buildSite(status, hash(status.launchId));
  site.group.position.copy(district.slotPosition(index));
  scene.add(site.group);
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'chip-label';
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', () => select(status.launchId));
  const label = new CSS2DObject(el);
  site.group.add(label);
  sites.set(status.launchId, { site, status, chip: el, label });
}

// A static snapshot (deploy/snapshot.ts) shows the city and its audits but
// cannot take bids or relay claims.
let snapshot = null;

function applyMeta(data) {
  snapshot = data.snapshot ?? null;
  document.body.toggleAttribute('data-snapshot', !!snapshot);
  if (snapshot) document.getElementById('snapshotNote').textContent = `Snapshot of ${moment(Date.parse(snapshot.takenAt) / 1000)}. Browse launches and check their audits. You can still make a real sealed bid here and pay it from a Zcash testnet wallet; claiming needs the live server.`;
  document.getElementById('zcashTip').textContent = data.zcashTip ? data.zcashTip.toLocaleString('en-US') : '…';
}

function showSite(s) {
  const entry = sites.get(s.launchId);
  if (!entry) return;
  entry.status = s;
  entry.site.update(s);
  entry.label.position.y = entry.site.labelHeight();
  entry.chip.innerHTML = `<b>${esc(s.name)}</b><span class="phase ${s.phase.replace(' ', '-')}">${esc(phaseLabel(s))}</span>`;
  entry.chip.classList.toggle('on', selected === s.launchId);
}

// A new index: refresh only what changed. Downtown buildings and the selected
// launch need full details; the archive needs only the index.
async function applyIndex(data) {
  const before = new Map(index.map((e) => [e.id, JSON.stringify(e)]));
  index = data.launches;
  applyMeta(data);
  const changed = index.filter((e) => before.get(e.id) !== JSON.stringify(e));
  const placed = (id) => sites.has(id) || archive?.has(id);
  const fresh = changed.filter((e) => !placed(e.id));
  // A launch that appears mid-visit joins the archive: downtown plots were laid
  // out at load, and the next load picks downtown again.
  if (fresh.length) rebuildArchive();
  const refresh = changed.filter((e) => sites.has(e.id) || e.id === selected).map((e) => e.id);
  await Promise.all(refresh.map((id) => fetchDetails(id).catch(() => null)));
  for (const id of refresh) if (details.has(id)) showSite(details.get(id));
  archive?.update(changed);
  if (selected && details.has(selected)) bid.update(details.get(selected));
  renderPanel();
}

function rebuildArchive() {
  if (archive) { scene.remove(archive.mesh); archive.mesh.geometry.dispose(); }
  plots = archivePlots(index);
  const archived = index.filter((e) => !sites.has(e.id));
  archive = archived.length ? buildArchive(archived, plots) : null;
  if (!archive) return;
  scene.add(archive.mesh);
  archive.select(selected);
  // See the whole archive: farther camera, fog pushed out past its edge.
  controls.maxDistance = Math.max(260, archive.radius * 1.9);
  scene.fog.far = Math.max(T.fogFar, archive.radius + 160);
  camera.far = Math.max(900, archive.radius * 5);
  camera.updateProjectionMatrix();
}

function detailRows(s) {
  const reserve = `${zec(s.reservePrice)} ZEC`;
  const rows = [
    ['Kind', s.kind === 'startup' ? 'Startup token' : 'Memecoin'],
    ['Supply', `${tokens(s.supply, s.decimals)} tokens`],
    ['Reserve price', `${reserve} / token`],
    ['Bidding blocks', `${s.startHeight.toLocaleString('en-US')} – ${s.endHeight.toLocaleString('en-US')}`],
  ];
  if (s.phase === 'live' && s.result) {
    rows.unshift(
      ['Clearing price', `${pricePerToken(s.result.price)} ZEC / token`],
      ['Sold', `${tokens(s.result.tokensSold, s.decimals)} tokens`],
      ['Raised', `${zec(s.result.raisedZats)} ZEC`],
      ['Claimed', `${Math.round(litFraction(s) * 100)}%`],
    );
  }
  if (s.pool) {
    rows.push(['Pool (burned LP)', `${tokens(s.pool.tokens, s.decimals)} tokens + ${(Number(s.pool.lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`]);
  }
  return rows.map(([k, v]) => `<div class="row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function phaseNote(s) {
  switch (s.phase) {
    case 'lot': return `Supply is locked on Solana. Bidding opens in ${s.blocksToStart} blocks.`;
    case 'bidding': return `${s.blocksLeft} blocks left. Bids are shielded Zcash payments: nobody can see who bid.${s.seal ? ' Prices stay sealed until the close; the launch wallet sees only the amounts.' : ' The launch wallet sees the amounts and, on this unsealed launch, the prices.'}`;
    case 'settling': return 'The window has closed. The result appears once it is final on Solana.';
    case 'no sale': return 'Nothing sold. Every bid was refunded and the supply went back to the creator.';
    case 'live': return 'Everyone paid the same price. Winners claim on Solana with the key from their bid.';
    default: return '';
  }
}

// The panel: tabs, search and sort over every launch, the selected launch's
// details, and a list that draws only the rows in view.
function buildPanel() {
  const panel = document.getElementById('launches');
  panel.innerHTML = `
    <div class="eyebrow">Launches <span id="launchCount"></span><button type="button" class="all-launches" hidden>All launches</button></div>
    <div class="dir-controls">
      <div class="dir-tabs" role="tablist">${TABS.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}">${esc(label)} <span></span></button>`).join('')}</div>
      <div class="dir-row"><input type="search" id="launchSearch" placeholder="Search launches" aria-label="Search launches" spellcheck="false">
      <select id="launchSort" aria-label="Sort launches">${SORTS.map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('')}</select></div>
    </div>
    <div id="launchDetail"></div>
    <div class="launch-list" id="launchList"><div class="launch-list-inner"></div></div>`;
  panel.querySelector('.all-launches').addEventListener('click', () => select(selected));
  panel.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { filter.tab = b.dataset.tab; renderPanel(); }));
  panel.querySelector('#launchSearch').addEventListener('input', (e) => { filter.q = e.target.value; renderList(); });
  panel.querySelector('#launchSort').addEventListener('change', (e) => { filter.sort = e.target.value; renderList(); });
  panel.querySelector('#launchList').addEventListener('scroll', () => renderList());
  // The list's height changes with the window and the details above it.
  new ResizeObserver(() => renderList()).observe(panel.querySelector('#launchList'));
}

function renderPanel() {
  const panel = document.getElementById('launches');
  const c = counts(index);
  panel.querySelector('#launchCount').textContent = index.length > SLOTS.length ? `(${index.length.toLocaleString('en-US')})` : '';
  panel.querySelectorAll('[data-tab]').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === filter.tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === filter.tab));
    b.querySelector('span').textContent = (c[b.dataset.tab] ?? 0).toLocaleString('en-US');
    b.hidden = b.dataset.tab !== 'all' && !c[b.dataset.tab];
  });
  panel.toggleAttribute('data-picked', !!selected);
  panel.querySelector('.all-launches').hidden = !selected;
  renderDetail();
  renderList();
}

function renderDetail() {
  const box = document.getElementById('launchDetail');
  const s = selected && details.get(selected);
  const focused = document.activeElement?.closest?.('#launchDetail [data-key]')?.dataset.key;
  if (!selected) { box.innerHTML = ''; return; }
  if (!s) { box.innerHTML = '<p class="note">Loading the launch…</p>'; return; }
  box.innerHTML = `
    <article class="launch on" data-id="${esc(s.launchId)}">
      <button type="button" class="launch-head" data-id="${esc(s.launchId)}" data-key="head:${esc(s.launchId)}" aria-expanded="true">
        <span class="launch-name">${esc(s.name)}</span>
        <span class="phase ${s.phase.replace(' ', '-')}">${esc(phaseLabel(s))}</span>
      </button>
      <p class="note">${esc(phaseNote(s))}</p>
      <dl class="rows">${detailRows(s)}</dl>
      <ul class="trust">${trustLines(s, Date.now() / 1000).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      ${s.pool ? '<p class="note">The pool opens at the clearing price. Its SOL is priced by a live NEAR Intents mainnet quote for the ZEC raised; NEAR Intents has no testnet, so the swap is not executed and the creator seeds the SOL.</p>' : ''}
      ${s.phase === 'bidding' ? `<button type="button" class="btn bid-open" data-id="${esc(s.launchId)}" data-key="bid:${esc(s.launchId)}">${esc(bidAction(s))}</button>` : ''}
      ${s.phase === 'live' && !snapshot ? `<button type="button" class="btn bid-open claim-open" data-id="${esc(s.launchId)}" data-key="claim:${esc(s.launchId)}">Claim tokens</button>` : ''}
      ${s.phase === 'live' || s.phase === 'no sale' ? `<button type="button" class="btn ghost bid-open audit-open" data-id="${esc(s.launchId)}" data-key="audit:${esc(s.launchId)}">Check the result</button>` : ''}
      <a class="ext" href="https://explorer.solana.com/address/${esc(s.mint)}?cluster=devnet" target="_blank" rel="noopener">Token on Solana devnet</a>
      ${s.pool ? `<a class="ext" href="https://explorer.solana.com/address/${esc(s.pool.id)}?cluster=devnet" target="_blank" rel="noopener">Raydium pool on devnet</a>` : ''}
    </article>`;
  // Redrawing replaces the buttons; keep keyboard focus on the same control.
  if (focused) focusKey(focused);
  box.querySelector('.launch-head').addEventListener('click', () => select(s.launchId));
  box.querySelectorAll('.bid-open:not(.claim-open):not(.audit-open)').forEach((b) => b.addEventListener('click', () => { opener = b.dataset.key; bid.open(details.get(b.dataset.id)); }));
  box.querySelectorAll('.claim-open').forEach((b) => b.addEventListener('click', () => { opener = b.dataset.key; claim.open(details.get(b.dataset.id)); }));
  box.querySelectorAll('.audit-open').forEach((b) => b.addEventListener('click', () => { opener = b.dataset.key; auditView.open(details.get(b.dataset.id)); }));
}

// Only the rows in view exist in the page, so the list costs the same for
// ten launches or ten thousand.
function renderList() {
  const list = document.getElementById('launchList');
  const inner = list.firstElementChild;
  const rows = listed(index, filter);
  const focused = document.activeElement?.closest?.('#launchList [data-key]')?.dataset.key;
  inner.style.height = `${rows.length * ROW}px`; // size first, so the measured height is the real one
  const { first, last } = visibleRange(list.scrollTop, list.clientHeight || 400, rows.length);
  inner.innerHTML = rows.slice(first, last).map((e, k) => `
    <button type="button" class="launch-row${e.id === selected ? ' on' : ''}" style="top:${(first + k) * ROW}px" data-id="${esc(e.id)}" data-key="row:${esc(e.id)}">
      <span class="launch-name">${esc(e.name)}</span>
      <span class="phase ${e.phase.replace(' ', '-')}">${esc(phaseLabel({ phase: e.phase, seal: e.sealed }))}</span>
    </button>`).join('') || `<p class="note">No launches match.</p>`;
  inner.querySelectorAll('.launch-row').forEach((b) => b.addEventListener('click', () => select(b.dataset.id)));
  if (focused) focusKey(focused);
}

const focusKey = (key) => {
  const el = document.querySelector(`#launches [data-key="${CSS.escape(key)}"]`) ?? document.querySelector(`#launches [data-key="${CSS.escape(key.replace(/^head:/, 'row:'))}"]`);
  el?.focus();
  return el ? true : undefined;
};

// Closing a dialog puts focus back on the button that opened it, even though
// the panel has been redrawn since.
let opener = null;
for (const id of ['bid', 'claim', 'audit']) {
  document.getElementById(id).addEventListener('close', () => {
    const key = opener;
    opener = null;
    if (!key) return;
    // The launch's heading if the button is gone; again a frame later in case
    // a redraw took focus away in between.
    const back = () => focusKey(key) ?? focusKey(`head:${key.split(':')[1]}`);
    back();
    requestAnimationFrame(() => { if (document.activeElement === document.body) back(); });
  });
}

// The selected archive tower gets a label of its own.
const archiveChip = Object.assign(document.createElement('button'), { type: 'button', className: 'chip-label on' });
archiveChip.addEventListener('pointerdown', (e) => e.stopPropagation());
archiveChip.addEventListener('click', () => selected && select(selected));
const archiveLabel = new CSS2DObject(archiveChip);
archiveLabel.visible = false;
scene.add(archiveLabel);

async function select(id) {
  selected = selected === id ? null : id;
  history.replaceState(null, '', selected ? launchLink(selected) : location.pathname + location.search);
  for (const [key, e] of sites) e.chip.classList.toggle('on', key === selected);
  archive?.select(selected);
  const site = selected && sites.get(selected);
  const top = selected && !site ? archive?.topOf(selected) : null;
  if (site) controls.target.copy(site.site.group.position).add(new THREE.Vector3(0, 8, 0));
  else if (top) controls.target.set(top.x, top.y / 2, top.z);
  const entry = top && index.find((e) => e.id === selected);
  archiveLabel.visible = !!entry;
  if (entry) {
    archiveLabel.position.set(top.x, top.y + 4, top.z);
    archiveChip.innerHTML = `<b>${esc(entry.name)}</b><span class="phase ${entry.phase.replace(' ', '-')}">${esc(phaseLabel({ phase: entry.phase, seal: entry.sealed }))}</span>`;
  }
  renderPanel();
  // On a phone the details replace the list; keep them in view.
  document.getElementById('launchDetail').scrollIntoView({ block: 'nearest' });
  if (selected && !details.has(selected)) {
    const want = selected;
    try { await fetchDetails(want); } catch (e) { console.warn('launch details failed', e); }
    if (selected === want) renderPanel();
  }
}

// Click a site in the 3D view to select it.
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let down = null;
canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  const rect = canvas.getBoundingClientRect();
  ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects([...sites.values()].map((s) => s.site.group), true).find((h) => h.object.userData.pickKey);
  const far = !hit && archive ? ray.intersectObject(archive.mesh)[0] : null;
  if (hit) select(hit.object.userData.pickKey);
  else if (far) select(archive.idAt(far.instanceId));
});

// Labels that would overlap on screen: the nearer one keeps its place and the
// farther one moves up above it. Positions are recomputed every frame from
// the projection, so nothing jitters.
const at = new THREE.Vector3();
function declutter() {
  const { clientWidth: w, clientHeight: h } = canvas;
  const shown = [...sites.values()].map(({ label, chip }) => ({ label, chip }));
  if (archiveLabel.visible) shown.push({ label: archiveLabel, chip: archiveChip });
  const items = shown.map(({ label, chip }) => {
    label.getWorldPosition(at);
    const dist = at.distanceTo(camera.position);
    at.project(camera);
    return { chip, dist, x: (at.x * 0.5 + 0.5) * w, y: (-at.y * 0.5 + 0.5) * h, bw: chip.offsetWidth, bh: chip.offsetHeight };
  }).sort((a, b) => a.dist - b.dist);
  const placed = [];
  items.forEach((it, i) => {
    let y = it.y;
    for (let moved = true; moved;) {
      moved = false;
      for (const p of placed) {
        if (Math.abs(it.x - p.x) < (it.bw + p.bw) / 2 + 4 && Math.abs(y - p.y) < (it.bh + p.bh) / 2 + 4) {
          y = p.y - (it.bh + p.bh) / 2 - 4; moved = true;
        }
      }
    }
    placed.push({ x: it.x, y, bw: it.bw, bh: it.bh });
    it.chip.style.marginTop = `${y - it.y}px`;
    it.chip.style.zIndex = String(items.length - i);
  });
}

async function start() {
  resize();
  const fill = document.getElementById('loadingFill');
  await loadAll((p) => { fill.style.width = `${Math.round(p * 100)}%`; });
  const data = await firstIndex();
  index = data.launches;
  applyMeta(data);
  // Downtown: the most relevant launches, as full buildings. Everyone else
  // stands in the archive around the district.
  const downtown = pickDowntown(index, SLOTS.length);
  await Promise.all(downtown.map((id) => (details.has(id) ? null : fetchDetails(id).catch(() => null))));
  // A small archive stands among the skyline (which steps aside); a large one replaces it.
  plots = archivePlots(index);
  const archivedPlots = index.filter((e) => !downtown.includes(e.id)).map((e) => plots.get(e.id));
  district = buildDistrict(downtown.length, { skyline: archivedPlots.length < 40, avoid: archivedPlots });
  scene.add(district.group);
  downtown.filter((id) => details.has(id)).forEach((id, i) => addSite(details.get(id), i));
  for (const id of downtown) if (details.has(id)) showSite(details.get(id));
  rebuildArchive();
  buildPanel();
  renderPanel();
  document.getElementById('loading').hidden = true;
  const linked = launchFromHash(location.hash);
  if (linked && index.some((e) => e.id === linked)) select(linked);
  window.addEventListener('hashchange', () => { const id = launchFromHash(location.hash); if (id && id !== selected && index.some((e) => e.id === id)) select(id); });
  let lastUpdate = Date.now();
  setInterval(async () => {
    const note = document.getElementById('connNote');
    try {
      await applyIndex(await fetchIndex());
      lastUpdate = Date.now();
      note.hidden = true;
    } catch (e) {
      note.textContent = `${explain(e, 'update the launches')} The city shows the last update, from ${moment(lastUpdate / 1000)}, and keeps trying every 15 seconds.`;
      note.hidden = false;
    }
  }, POLL_MS);
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dt = Math.min(0.05, timer.getDelta()), t = timer.getElapsed();
    district.tick(dt);
    for (const { site } of sites.values()) site.tick(dt, t);
    scene.traverse((o) => { if (o.userData.spin) o.rotation.y += dt * 0.6; });
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
    declutter();
  });
}

// The first load waits for the server: it says what is wrong, retries every
// 15 seconds, and lets the visitor retry at once.
async function firstIndex() {
  for (;;) {
    try { return await fetchIndex(); } catch (e) { await retryAfter(explain(e, 'load the launches')); }
  }
}

function retryAfter(text) {
  const note = document.getElementById('loadingNote'), button = document.getElementById('loadingRetry');
  note.textContent = text;
  button.hidden = false;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); button.removeEventListener('click', done); button.hidden = true; note.textContent = 'Trying again…'; resolve(); };
    const timer = setTimeout(done, POLL_MS);
    button.addEventListener('click', done);
  });
}

start().catch((e) => {
  document.getElementById('loadingNote').textContent = explain(e, "load the city's 3D models");
  console.error(e);
});
