// One launch as a building site in the city. Phases (see view-model.js):
//   lot      concrete pad, crane, cones: supply locked, bidding not open yet
//   fog      scaffold wrapped in fog while bids are sealed. The scaffold has a
//            fixed height, so the city reveals nothing about demand.
//   live     the tower: height from the share sold, windows lit as tokens are claimed
//   no sale  an empty pad
// When a site goes from fog to live while you watch, the fog clears and the
// tower rises: the reveal.

import * as THREE from 'three';
import { model } from './assets.js';
import { rng } from './rng.js';
import { T } from './theme.js';
import { FOGGY, floorsFor, litFraction, signLines } from './view-model.js';

export const FLOOR_H = 3.2;
const PAD = 18, TOWER_W = 10.5, SCAFFOLD_FLOORS = 12, COLS = 6;
const REVEAL_SECONDS = 2.6;

const std = (color, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: new THREE.Color(color), roughness: 0.85 }, o));
function box(w, h, d, mat) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.castShadow = true; m.receiveShadow = true; return m; }

export function buildSite(status, seed) {
  const g = new THREE.Group();
  const pad = box(PAD, 0.3, PAD, std(T.pad)); pad.position.y = 0.15; g.add(pad);
  const parts = {
    lot: lotProps(),
    fog: fogCloud(seed),
    tower: new THREE.Group(),
    sign: makeSign(),
  };
  parts.sign.mesh.position.set(0, 3.1, PAD / 2 + 0.6);
  g.add(parts.lot.group, parts.fog.group, parts.tower, parts.sign.mesh);
  g.traverse(o => { if (o.isMesh || o.isSprite) o.userData.pickKey = status.launchId; });

  let phase = null, reveal = -1, towerKey = '', floors = 0;
  const site = {
    group: g,
    // Where the floating label sits: just above whatever stands on the site.
    labelHeight() {
      if (phase === 'live') return floors * FLOOR_H + 7;
      if (FOGGY.has(phase)) return SCAFFOLD_FLOORS * FLOOR_H + 10;
      return phase === 'lot' ? 31 : 9;
    },
    update(next) {
      const wasFoggy = FOGGY.has(phase);
      phase = next.phase;
      parts.sign.draw(signLines(next));
      parts.lot.group.visible = phase === 'lot' || phase === 'no sale';
      parts.lot.crane.visible = phase === 'lot';
      parts.fog.group.visible = FOGGY.has(phase);
      floors = floorsFor(next);
      const key = `${floors}:${litFraction(next).toFixed(3)}`;
      if (phase === 'live' && key !== towerKey) {
        towerKey = key;
        parts.tower.clear();
        parts.tower.add(buildTower(floorsFor(next), litFraction(next), seed));
      }
      parts.tower.visible = phase === 'live';
      if (phase === 'live' && wasFoggy) { reveal = 0; parts.tower.scale.y = 0.001; parts.fog.group.visible = true; }
      g.traverse(o => { if (o.isMesh || o.isSprite) o.userData.pickKey = next.launchId; });
    },
    tick(dt, t) {
      parts.fog.drift(t);
      if (reveal < 0) return;
      reveal = Math.min(1, reveal + dt / REVEAL_SECONDS);
      const e = 1 - Math.pow(1 - reveal, 3);
      parts.tower.scale.y = Math.max(0.001, e);
      parts.fog.fade(1 - e);
      if (reveal === 1) { reveal = -1; parts.fog.group.visible = false; parts.fog.fade(1); }
    },
  };
  site.update(status);
  return site;
}

function lotProps() {
  const group = new THREE.Group();
  [[-6, 6], [6, 6], [-6, -6], [6, -6]].forEach(([x, z]) => { const c = model('construction-cone', 1.6); c.position.set(x, 0.3, z); group.add(c); });
  const bar = model('construction-barrier', 3); bar.position.set(0, 0.3, 7.5); group.add(bar);
  const crane = new THREE.Group();
  const steel = std(T.accent, { roughness: 0.6 });
  const mast = box(0.8, 26, 0.8, steel); mast.position.set(-5, 13.3, -5); crane.add(mast);
  const jib = box(20, 0.6, 0.6, steel); jib.position.set(1, 26, -5); crane.add(jib);
  const weight = box(2.5, 1.6, 1.6, std('#5B606B')); weight.position.set(-8.5, 25.2, -5); crane.add(weight);
  const cable = box(0.08, 9, 0.08, std('#2A2F3A')); cable.position.set(8, 21.5, -5); crane.add(cable);
  group.add(crane);
  return { group, crane };
}

// Translucent puffs around a scaffold of fixed height: sealed, not empty.
function fogCloud(seed) {
  const group = new THREE.Group();
  const r = rng(seed);
  const pole = std(T.pole, { roughness: 0.5, metalness: 0.3 });
  const H = SCAFFOLD_FLOORS * FLOOR_H, half = TOWER_W / 2;
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([x, z]) => { const p = box(0.3, H, 0.3, pole); p.position.set(x * half, H / 2 + 0.3, z * half); group.add(p); });
  for (let f = 1; f <= SCAFFOLD_FLOORS; f += 2) {
    const y = f * FLOOR_H + 0.3;
    [[0, -half, TOWER_W, 0.2], [0, half, TOWER_W, 0.2], [-half, 0, 0.2, TOWER_W], [half, 0, 0.2, TOWER_W]].forEach(([x, z, w, d]) => {
      const rail = box(w, 0.18, d, pole); rail.position.set(x, y, z); group.add(rail);
    });
  }
  // Soft camera-facing puffs, kept inside the pad so neighbouring sites
  // never merge into one cloud.
  const mat = new THREE.SpriteMaterial({ map: puffTexture(), color: T.puff, transparent: true, opacity: T.puffOpacity, depthWrite: false });
  const puffs = [];
  for (let k = 0; k < 60; k++) {
    const s = 10 + r() * 7;
    const m = new THREE.Sprite(mat);
    m.scale.set(s, s, 1);
    const a = r() * Math.PI * 2, rad = 2 + r() * 4.5, y = 2 + r() * (H + 1);
    m.position.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
    m.userData = { a, rad, y, speed: 0.05 + r() * 0.08, bob: r() * 6 };
    group.add(m); puffs.push(m);
  }
  return {
    group,
    drift(t) {
      for (const p of puffs) {
        const { a, rad, y, speed, bob } = p.userData;
        p.position.x = Math.cos(a + t * speed) * rad;
        p.position.z = Math.sin(a + t * speed) * rad;
        p.position.y = y + Math.sin(t * 0.4 + bob) * 0.6;
      }
    },
    fade(k) { mat.opacity = T.puffOpacity * k; },
  };
}

let puff = null;
function puffTexture() {
  if (puff) return puff;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  puff = new THREE.CanvasTexture(c); puff.colorSpace = THREE.SRGBColorSpace;
  return puff;
}

function buildTower(floors, lit, seed) {
  const g = new THREE.Group();
  const H = floors * FLOOR_H;
  const cv = document.createElement('canvas'), ecv = document.createElement('canvas');
  cv.width = ecv.width = COLS * 32; cv.height = ecv.height = floors * 32;
  const a = cv.getContext('2d'), e = ecv.getContext('2d');
  a.fillStyle = T.towerBase; a.fillRect(0, 0, cv.width, cv.height);
  e.fillStyle = '#000'; e.fillRect(0, 0, ecv.width, ecv.height);
  const r = rng(seed + 7);
  const windows = [];
  for (let y = 0; y < floors; y++) for (let x = 0; x < COLS; x++) windows.push([x, y, r()]);
  windows.sort((p, q) => p[2] - q[2]);
  const litCount = Math.round(lit * windows.length);
  windows.forEach(([x, y], i) => {
    const on = i < litCount;
    a.fillStyle = on ? T.windowLit : T.windowDark; a.fillRect(x * 32 + 6, y * 32 + 7, 20, 18);
    if (on) { e.fillStyle = T.windowGlow; e.fillRect(x * 32 + 6, y * 32 + 7, 20, 18); }
  });
  const tex = new THREE.CanvasTexture(cv), etex = new THREE.CanvasTexture(ecv);
  tex.colorSpace = etex.colorSpace = THREE.SRGBColorSpace;
  const side = new THREE.MeshStandardMaterial({ map: tex, emissive: new THREE.Color('#ffffff'), emissiveMap: etex, emissiveIntensity: 0.9, roughness: 0.7 });
  const roof = std(T.roof);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(TOWER_W, H, TOWER_W), [side, side, roof, roof, side, side]);
  tower.castShadow = true; tower.position.y = H / 2 + 0.3; g.add(tower);
  const crown = box(TOWER_W + 0.6, 0.6, TOWER_W + 0.6, std(T.accent, { emissive: new THREE.Color(T.accent), emissiveIntensity: 0.25 }));
  crown.position.y = H + 0.6; g.add(crown);
  return g;
}

function makeSign() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 3.5),
    new THREE.MeshStandardMaterial({ map: tex, emissive: new THREE.Color('#ffffff'), emissiveMap: tex, emissiveIntensity: 0.45, roughness: 0.6 }),
  );
  return {
    mesh,
    draw([title, sub]) {
      g.fillStyle = T.signBg; g.fillRect(0, 0, 1024, 256);
      g.fillStyle = T.accent; g.fillRect(0, 238, 1024, 18);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = T.signText; g.font = `800 112px ${T.signFont}`; g.fillText(title, 512, 92);
      g.fillStyle = T.accent; g.font = `500 44px ${T.signMono}`; g.fillText(sub, 512, 190);
      tex.needsUpdate = true;
    },
  };
}
