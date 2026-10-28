// The archive: every launch that is not downtown, as plain towers on stable
// plots around the district (directory.js archivePlot). One instanced mesh,
// one draw call, however many launches there are. Windows are drawn by the
// shader, lit in proportion to what has been claimed, so there is no texture
// per tower.

import * as THREE from 'three';
import { T } from './theme.js';

const WIDTH = 5.2, FLOOR = 2.6, MAX_FLOORS = 16, MIN_FLOORS = 3;

// How a tower reads: height from the share sold, lights from claims. Launches
// still bidding or counting stand pale and short, as if in fog.
function look(e) {
  if (e.phase === 'live') return { floors: Math.max(MIN_FLOORS, Math.round(MAX_FLOORS * e.sold)), lit: e.lit, color: T.towerBase };
  if (e.phase === 'no sale') return { floors: 1, lit: 0, color: '#6B7180' };
  if (e.phase === 'lot') return { floors: 2, lit: 0, color: T.accent };
  return { floors: 4, lit: 0, color: T.puff };
}

export function buildArchive(entries, plots) {
  const geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const lit = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, entries.length)), 1);
  const floors = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, entries.length)), 1);
  const seed = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, entries.length)), 1);
  geometry.setAttribute('aLit', lit);
  geometry.setAttribute('aFloors', floors);
  geometry.setAttribute('aSeed', seed);
  const material = windowMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, entries.length));
  mesh.count = entries.length;
  mesh.receiveShadow = true;
  const ids = entries.map((e) => e.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const m = new THREE.Matrix4(), color = new THREE.Color();
  let selected = null;

  function place(e, i) {
    const p = plots.get(e.id), l = look(e);
    const grow = selected === e.id ? 1.25 : 1;
    m.makeScale(WIDTH * grow, l.floors * FLOOR, WIDTH * grow).setPosition(p.x, 0, p.z);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, color.set(selected === e.id ? T.accent : l.color));
    lit.setX(i, l.lit); floors.setX(i, l.floors); seed.setX(i, (Number(BigInt(e.id) % 9973n)) / 97.3);
  }
  entries.forEach(place);
  const flush = () => {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    lit.needsUpdate = floors.needsUpdate = seed.needsUpdate = true;
    mesh.computeBoundingSphere();
  };
  flush();

  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    mesh,
    radius: Math.max(0, ...[...plots.values()].map((p) => p.r)),
    has: (id) => index.has(id),
    idAt: (instanceId) => ids[instanceId] ?? null,
    // Top of a tower, for the camera and the label of a selected one.
    topOf(id) {
      const e = byId.get(id), p = plots.get(id);
      return e && p ? new THREE.Vector3(p.x, look(e).floors * FLOOR, p.z) : null;
    },
    update(fresh) {
      for (const e of fresh) {
        const i = index.get(e.id);
        if (i === undefined) continue;
        byId.set(e.id, e);
        place(e, i);
      }
      flush();
    },
    select(id) {
      const was = selected;
      selected = index.has(id) ? id : null;
      for (const x of [was, selected]) if (x && index.has(x)) place(byId.get(x), index.get(x));
      flush();
    },
  };
}

// A standard material with windows: a grid of cells on the side faces, each
// lit or dark from a per-tower hash, so a tower's lit share equals aLit.
function windowMaterial() {
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLit = { value: new THREE.Color(T.windowLit) };
    shader.uniforms.uGlow = { value: new THREE.Color(T.windowGlow) };
    shader.uniforms.uDark = { value: new THREE.Color(T.windowDark) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aLit; attribute float aFloors; attribute float aSeed;
        varying vec2 vBox; varying float vLit; varying float vFloors; varying float vSeed; varying float vSide;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBox = uv; vLit = aLit; vFloors = aFloors; vSeed = aSeed; vSide = abs(normal.y) < 0.5 ? 1.0 : 0.0;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uLit; uniform vec3 uGlow; uniform vec3 uDark;
        varying vec2 vBox; varying float vLit; varying float vFloors; varying float vSeed; varying float vSide;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vSide > 0.5) {
          vec2 grid = vec2(4.0, max(1.0, vFloors));
          vec2 cell = floor(vBox * grid), f = fract(vBox * grid);
          float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.8);
          float h = fract(sin(dot(cell + vSeed, vec2(12.9898, 78.233))) * 43758.5453);
          float on = step(h, vLit) * step(0.001, vLit);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(uDark, uLit, on), win);
          totalEmissiveRadiance += uGlow * on * win * 0.9;
        } else {
          diffuseColor.rgb *= 0.55;
        }`);
  };
  return material;
}
