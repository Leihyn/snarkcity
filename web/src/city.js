// The district: a grid of blocks with roads, a central plaza, filler
// buildings, a skyline ring and some traffic. Launch sites take the slots
// around the plaza, in the order the server lists them.

import * as THREE from 'three';
import { model, CAR_NAMES } from './assets.js';
import { rng } from './rng.js';
import { T } from './theme.js';

export const BLOCK = 20, PITCH = 25, TILE = 5;
const LINES = [-62.5, -37.5, -12.5, 12.5, 37.5, 62.5];
// Block coordinates for launch sites, nearest the plaza first.
export const SLOTS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [1, -1], [-1, 1]];
// Where the camera starts. Tall filler only goes on the far half of the
// district, so nothing stands between this view and a launch.
export const VIEW = [105, 92, 125];

const std = (color, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: new THREE.Color(color), roughness: 0.9 }, o));

export function buildDistrict(slotCount) {
  const group = new THREE.Group();
  const r = rng(20261028);
  const cars = [];
  const taken = new Set(SLOTS.slice(0, slotCount).map((s) => s.join(',')));

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), std(T.ground, { roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; group.add(ground);

  LINES.forEach((lz) => {
    for (let k = 0; k <= 25; k++) {
      const p = -62.5 + k * TILE;
      if (LINES.some((l) => Math.abs(l - p) < 0.01)) { const t = model('road-crossroad', TILE); t.position.set(p, 0.02, lz); group.add(t); continue; }
      const a = model('road-straight', TILE); a.position.set(p, 0.02, lz); a.rotation.y = Math.PI / 2; group.add(a);
      const b = model('road-straight', TILE); b.position.set(lz, 0.02, p); group.add(b);
    }
  });

  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const cx = i * PITCH, cz = j * PITCH;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(BLOCK, 0.25, BLOCK), std(T.block));
    pad.position.set(cx, 0.125, cz); pad.receiveShadow = true; group.add(pad);
    if (i === 0 && j === 0) { addPlaza(group, cx, cz, r); continue; }
    if (taken.has(`${i},${j}`)) continue;
    // Next to the plaza and in front of the view only low buildings, so
    // launches stand out and none is hidden.
    const low = (Math.abs(i) <= 1 && Math.abs(j) <= 1) || i * VIEW[0] + j * VIEW[2] > 0;
    if (r() < 0.16) addPark(group, cx, cz, r); else addFiller(group, cx, cz, r, low);
  }

  const skyline = ['low-detail-building-a', 'low-detail-building-b', 'low-detail-building-c', 'low-detail-building-d', 'low-detail-building-e', 'low-detail-building-f', 'low-detail-building-g', 'low-detail-building-h', 'low-detail-building-wide-a', 'low-detail-building-wide-b'];
  for (let k = 0; k < 70; k++) {
    const ang = r() * Math.PI * 2, rad = 82 + r() * 70;
    const b = model(skyline[Math.floor(r() * skyline.length)], 10 + r() * 8);
    b.position.set(Math.cos(ang) * rad, 0, Math.sin(ang) * rad); b.rotation.y = Math.floor(r() * 4) * Math.PI / 2; group.add(b);
  }

  [-37.5, -12.5, 12.5, 37.5].forEach((line, li) => {
    for (let k = 0; k < 3; k++) {
      const c = model(CAR_NAMES[Math.floor(r() * CAR_NAMES.length)], 0.85);
      group.add(c);
      cars.push({ m: c, alongX: (k + li) % 2 === 0, line, dir: k < 2 ? 1 : -1, t: r() * 125, v: 6 + r() * 5 });
    }
  });

  return {
    group,
    slotPosition: (i) => new THREE.Vector3(SLOTS[i][0] * PITCH, 0.25, SLOTS[i][1] * PITCH),
    tick(dt) {
      for (const c of cars) {
        c.t = (c.t + c.v * dt * c.dir + 125) % 125;
        const p = -62.5 + c.t, lane = c.dir * 1.2;
        if (c.alongX) { c.m.position.set(p, 0.05, c.line + lane); c.m.rotation.y = c.dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
        else { c.m.position.set(c.line - lane, 0.05, p); c.m.rotation.y = c.dir > 0 ? 0 : Math.PI; }
      }
    },
  };
}

function addPlaza(group, cx, cz, r) {
  const stone = new THREE.Mesh(new THREE.BoxGeometry(BLOCK - 2, 0.3, BLOCK - 2), std(T.plaza));
  stone.position.set(cx, 0.28, cz); group.add(stone);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const t = model('tree_detailed', 5); t.position.set(cx + Math.cos(a) * 6.5, 0.4, cz + Math.sin(a) * 6.5); group.add(t);
  }
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 1.2, 24), std(T.plinth));
  plinth.position.set(cx, 0.9, cz); group.add(plinth);
  const mark = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.32, 12, 32), std(T.accent, { emissive: new THREE.Color(T.accent), emissiveIntensity: 0.4, metalness: 0.3, roughness: 0.4 }));
  mark.position.set(cx, 3.1, cz); mark.userData.spin = true; group.add(mark);
  r();
}

function addFiller(group, cx, cz, r, low) {
  const tall = ['building-skyscraper-a', 'building-skyscraper-b', 'building-skyscraper-c', 'building-skyscraper-d', 'building-skyscraper-e'];
  const small = ['building-a', 'building-b', 'building-c', 'building-d', 'building-f', 'building-g', 'building-h', 'building-l', 'building-m'];
  if (!low && r() < 0.5) {
    const b = model(tall[Math.floor(r() * tall.length)], 9); b.position.set(cx - 3, 0.25, cz - 3); b.rotation.y = Math.floor(r() * 4) * Math.PI / 2; group.add(b);
    const c = model(small[Math.floor(r() * small.length)], 8); c.position.set(cx + 5, 0.25, cz + 5); c.rotation.y = Math.PI; group.add(c);
    return;
  }
  [[-4.5, -4.5, 0], [4.5, -4.5, Math.PI / 2], [-4.5, 4.5, -Math.PI / 2], [4.5, 4.5, Math.PI]].forEach(([dx, dz, ry]) => {
    const b = model(small[Math.floor(r() * small.length)], 8.5); b.position.set(cx + dx, 0.25, cz + dz); b.rotation.y = ry; group.add(b);
  });
}

function addPark(group, cx, cz, r) {
  const lawn = new THREE.Mesh(new THREE.BoxGeometry(BLOCK - 3, 0.3, BLOCK - 3), std(T.lawn));
  lawn.position.set(cx, 0.28, cz); lawn.receiveShadow = true; group.add(lawn);
  for (let k = 0; k < 6; k++) {
    const t = model(r() < 0.6 ? 'tree_default' : 'tree_oak', 5 + r() * 2.5);
    t.position.set(cx + (r() - 0.5) * 14, 0.4, cz + (r() - 0.5) * 14); t.rotation.y = r() * 6; group.add(t);
  }
}
