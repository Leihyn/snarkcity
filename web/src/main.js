import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadAll } from './assets.js';
import { buildDistrict, SLOTS, VIEW } from './city.js';
import { bidScreen } from './bid-screen.js';
import { auditScreen } from './audit-screen.js';
import { claimScreen } from './claim-screen.js';
import { buildSite } from './site.js';
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

const sites = new Map(); // launchId -> { site, status, chip }
let district = null;
let selected = null;
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

async function fetchLaunches() {
  const res = await fetch('/api/launches', { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new HttpError(res.status);
  return res.json();
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

function apply(data) {
  snapshot = data.snapshot ?? null;
  document.body.toggleAttribute('data-snapshot', !!snapshot);
  if (snapshot) document.getElementById('snapshotNote').textContent = `Snapshot of ${moment(Date.parse(snapshot.takenAt) / 1000)}. Browse launches and check their audits; bidding and claiming need the live server.`;
  document.getElementById('zcashTip').textContent = data.zcashTip ? data.zcashTip.toLocaleString('en-US') : '…';
  data.launches.slice(0, SLOTS.length).forEach((s) => {
    const entry = sites.get(s.launchId);
    if (!entry) return;
    entry.status = s;
    entry.site.update(s);
    entry.label.position.y = entry.site.labelHeight();
    entry.chip.innerHTML = `<b>${esc(s.name)}</b><span class="phase ${s.phase.replace(' ', '-')}">${esc(phaseLabel(s))}</span>`;
    entry.chip.classList.toggle('on', selected === s.launchId);
    bid.update(s);
  });
  renderPanel();
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

function renderPanel() {
  const list = [...sites.values()];
  const cards = list.map(({ status: s }) => `
    <article class="launch ${selected === s.launchId ? 'on' : ''}" data-id="${esc(s.launchId)}">
      <button type="button" class="launch-head" data-id="${esc(s.launchId)}" data-key="head:${esc(s.launchId)}" aria-expanded="${selected === s.launchId}">
        <span class="launch-name">${esc(s.name)}</span>
        <span class="phase ${s.phase.replace(' ', '-')}">${esc(phaseLabel(s))}</span>
      </button>
      ${selected === s.launchId ? `
        <p class="note">${esc(phaseNote(s))}</p>
        <dl class="rows">${detailRows(s)}</dl>
        <ul class="trust">${trustLines(s, Date.now() / 1000).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        ${s.pool ? '<p class="note">The pool opens at the clearing price. Its SOL is priced by a live NEAR Intents mainnet quote for the ZEC raised; NEAR Intents has no testnet, so the swap is not executed and the creator seeds the SOL.</p>' : ''}
        ${s.phase === 'bidding' && !snapshot ? `<button type="button" class="btn bid-open" data-id="${esc(s.launchId)}" data-key="bid:${esc(s.launchId)}">${esc(bidAction(s))}</button>` : ''}
        ${s.phase === 'live' && !snapshot ? `<button type="button" class="btn bid-open claim-open" data-id="${esc(s.launchId)}" data-key="claim:${esc(s.launchId)}">Claim tokens</button>` : ''}
        ${s.phase === 'live' || s.phase === 'no sale' ? `<button type="button" class="btn ghost bid-open audit-open" data-id="${esc(s.launchId)}" data-key="audit:${esc(s.launchId)}">Check the result</button>` : ''}
        <a class="ext" href="https://explorer.solana.com/address/${esc(s.mint)}?cluster=devnet" target="_blank" rel="noopener">Token on Solana devnet</a>
        ${s.pool ? `<a class="ext" href="https://explorer.solana.com/address/${esc(s.pool.id)}?cluster=devnet" target="_blank" rel="noopener">Raydium pool on devnet</a>` : ''}` : ''}
    </article>`).join('');
  const panel = document.getElementById('launches');
  // Redrawing replaces the buttons; keep keyboard focus on the same control.
  const focused = document.activeElement?.closest?.('#launches [data-key]')?.dataset.key;
  panel.toggleAttribute('data-picked', !!selected);
  panel.innerHTML = `<div class="eyebrow">Launches${selected ? '<button type="button" class="all-launches">All launches</button>' : ''}</div>${cards}`;
  if (focused) focusKey(focused);
  panel.querySelector('.all-launches')?.addEventListener('click', () => select(selected));
  panel.querySelectorAll('.launch-head').forEach((b) => b.addEventListener('click', () => select(b.dataset.id)));
  panel.querySelectorAll('.bid-open:not(.claim-open):not(.audit-open)').forEach((b) => b.addEventListener('click', () => { opener = b.dataset.key; bid.open(sites.get(b.dataset.id).status); }));
  panel.querySelectorAll('.claim-open').forEach((b) => b.addEventListener('click', () => { opener = b.dataset.key; claim.open(sites.get(b.dataset.id).status); }));
  panel.querySelectorAll('.audit-open').forEach((b) => b.addEventListener('click', () => { opener = b.dataset.key; auditView.open(sites.get(b.dataset.id).status); }));
}

const focusKey = (key) => {
  const el = document.querySelector(`#launches [data-key="${CSS.escape(key)}"]`);
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

function select(id) {
  selected = selected === id ? null : id;
  const entry = selected && sites.get(selected);
  if (entry) controls.target.copy(entry.site.group.position).add(new THREE.Vector3(0, 8, 0));
  for (const [key, e] of sites) e.chip.classList.toggle('on', key === selected);
  renderPanel();
  // The details open inside the list; on a phone they would be out of sight.
  document.querySelector('#launches .launch.on')?.scrollIntoView({ block: 'nearest' });
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
  if (hit) select(hit.object.userData.pickKey);
});

// Labels that would overlap on screen: the nearer one keeps its place and the
// farther one moves up above it. Positions are recomputed every frame from
// the projection, so nothing jitters.
const at = new THREE.Vector3();
function declutter() {
  const { clientWidth: w, clientHeight: h } = canvas;
  const items = [...sites.values()].map(({ label, chip }) => {
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
  const data = await firstLaunches();
  district = buildDistrict(Math.min(data.launches.length, SLOTS.length));
  scene.add(district.group);
  data.launches.slice(0, SLOTS.length).forEach(addSite);
  apply(data);
  document.getElementById('loading').hidden = true;
  let lastUpdate = Date.now();
  setInterval(async () => {
    const note = document.getElementById('connNote');
    try {
      apply(await fetchLaunches());
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
async function firstLaunches() {
  for (;;) {
    try { return await fetchLaunches(); } catch (e) { await retryAfter(explain(e, 'load the launches')); }
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
