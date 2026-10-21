import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadAll } from './assets.js';
import { buildDistrict, SLOTS } from './city.js';
import { buildSite } from './site.js';
import { hash } from './rng.js';
import { litFraction, PHASE_LABEL, pricePerToken, tokens, zec } from './view-model.js';

const POLL_MS = 15_000;
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#1B2233');
scene.fog = new THREE.Fog('#1B2233', 140, 320);
const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 900);
camera.position.set(105, 92, 125);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 12, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 25;
controls.maxDistance = 260;
const labels = new CSS2DRenderer();
labels.domElement.className = 'labels';
document.getElementById('app').appendChild(labels.domElement);

scene.add(new THREE.HemisphereLight('#C8D6FF', '#2B2F38', 0.95));
const sun = new THREE.DirectionalLight('#FFE2B8', 1.7);
sun.position.set(-60, 110, 50);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, far: 320 });
scene.add(sun);

const sites = new Map(); // launchId -> { site, status, chip }
let district = null;
let selected = null;

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
  const res = await fetch('/api/launches', { cache: 'no-store' });
  if (!res.ok) throw new Error(`api ${res.status}`);
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

function apply(data) {
  document.getElementById('zcashTip').textContent = data.zcashTip ? data.zcashTip.toLocaleString('en-US') : '…';
  data.launches.slice(0, SLOTS.length).forEach((s) => {
    const entry = sites.get(s.launchId);
    if (!entry) return;
    entry.status = s;
    entry.site.update(s);
    entry.label.position.y = entry.site.labelHeight();
    entry.chip.innerHTML = `<b>${esc(s.name)}</b><span class="phase ${s.phase.replace(' ', '-')}">${esc(PHASE_LABEL[s.phase])}</span>`;
    entry.chip.classList.toggle('on', selected === s.launchId);
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
  return rows.map(([k, v]) => `<div class="row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function phaseNote(s) {
  switch (s.phase) {
    case 'lot': return `Supply is locked on Solana. Bidding opens in ${s.blocksToStart} blocks.`;
    case 'bidding': return `${s.blocksLeft} blocks left. Bids are shielded Zcash payments: nobody can see who bid or how much.`;
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
      <button type="button" class="launch-head" data-id="${esc(s.launchId)}">
        <span class="launch-name">${esc(s.name)}</span>
        <span class="phase ${s.phase.replace(' ', '-')}">${esc(PHASE_LABEL[s.phase])}</span>
      </button>
      ${selected === s.launchId ? `
        <p class="note">${esc(phaseNote(s))}</p>
        <dl class="rows">${detailRows(s)}</dl>
        <a class="ext" href="https://explorer.solana.com/address/${esc(s.mint)}?cluster=devnet" target="_blank" rel="noopener">Token on Solana devnet</a>` : ''}
    </article>`).join('');
  const panel = document.getElementById('launches');
  panel.innerHTML = `<div class="eyebrow">Launches</div>${cards}`;
  panel.querySelectorAll('.launch-head').forEach((b) => b.addEventListener('click', () => select(b.dataset.id)));
}

function select(id) {
  selected = selected === id ? null : id;
  const entry = selected && sites.get(selected);
  if (entry) controls.target.copy(entry.site.group.position).add(new THREE.Vector3(0, 8, 0));
  for (const [key, e] of sites) e.chip.classList.toggle('on', key === selected);
  renderPanel();
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

async function start() {
  resize();
  const fill = document.getElementById('loadingFill');
  await loadAll((p) => { fill.style.width = `${Math.round(p * 100)}%`; });
  const data = await fetchLaunches();
  district = buildDistrict(Math.min(data.launches.length, SLOTS.length));
  scene.add(district.group);
  data.launches.slice(0, SLOTS.length).forEach(addSite);
  apply(data);
  document.getElementById('loading').hidden = true;
  setInterval(async () => {
    try { apply(await fetchLaunches()); } catch (e) { console.warn('launch update failed', e); }
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
  });
}

start().catch((e) => {
  document.getElementById('loadingNote').textContent = `Could not load the city: ${e.message}`;
  console.error(e);
});
