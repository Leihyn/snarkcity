import * as THREE from 'three';
import { T } from './theme.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const loader = new GLTFLoader();
const cache = new Map();
export const mixers = new Set();

const CITY = ['building-a','building-b','building-c','building-d','building-e','building-f','building-g','building-h','building-i','building-j','building-k','building-l','building-m','building-n','building-skyscraper-a','building-skyscraper-b','building-skyscraper-c','building-skyscraper-d','building-skyscraper-e','low-detail-building-a','low-detail-building-b','low-detail-building-c','low-detail-building-d','low-detail-building-e','low-detail-building-f','low-detail-building-g','low-detail-building-h','low-detail-building-wide-a','low-detail-building-wide-b','detail-awning-wide','detail-parasol-a'];
const ROADS = ['road-straight','road-crossroad','light-square','light-curved','traffic-light','construction-cone','construction-barrier'];
const CHARS = ['character-female-a','character-female-b','character-female-c','character-female-d','character-female-e','character-female-f','character-male-a','character-male-b','character-male-c','character-male-d','character-male-e','character-male-f'];
const CARS = ['sedan','taxi','suv','van','delivery','hatchback-sports','police'];
const NATURE = ['tree_default','tree_oak','tree_detailed','tree_palmDetailedTall','plant_bush','plant_bushLarge'];

export const PATHS = {};
CITY.forEach(n => PATHS[n] = `assets/city/${n}.glb`);
ROADS.forEach(n => PATHS[n] = `assets/roads/${n}.glb`);
CHARS.forEach(n => PATHS[n] = `assets/chars/${n}.glb`);
CARS.forEach(n => PATHS[n] = `assets/cars/${n}.glb`);
NATURE.forEach(n => PATHS[n] = `assets/nature/${n}.glb`);
export const CHAR_NAMES = CHARS;
export const CAR_NAMES = CARS;

export async function loadAll(onProgress) {
  const names = Object.keys(PATHS);
  let done = 0;
  await Promise.all(names.map(async (n) => {
    try {
      const g = await loader.loadAsync(PATHS[n]);
      g.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      cache.set(n, g);
    } catch (e) {
      console.warn('Model failed to load:', n, e);
    }
    done++;
    if (onProgress) onProgress(done / names.length);
  }));
}

export function has(name) { return cache.has(name); }

// A static model, scaled, with its footprint centred on the origin and its base on y = 0.
export function model(name, scale = 1) {
  const g = cache.get(name);
  if (!g) return new THREE.Group();
  if (T.tint && !g.tinted) {
    // Materials are shared between clones, so tint them once.
    const tint = new THREE.Color(T.tint);
    g.scene.traverse((o) => { if (o.isMesh) [o.material].flat().forEach((m) => m.color?.multiply(tint)); });
    g.tinted = true;
  }
  const obj = g.scene.clone(true);
  obj.scale.setScalar(scale);
  return centered(obj);
}

export function centered(obj) {
  const wrap = new THREE.Group();
  wrap.add(obj);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= box.min.y;
  return wrap;
}

// An animated character with its own mixer.
export function character(name, scale = 2.4) {
  const g = cache.get(name) || cache.get(CHARS[0]);
  const obj = SkeletonUtils.clone(g.scene);
  obj.scale.setScalar(scale);
  obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  const mixer = new THREE.AnimationMixer(obj);
  let current = null, currentName = '';
  const root = new THREE.Group();
  root.add(obj);
  const api = {
    root, obj, mixer, active: true,
    play(clipName, fade = 0.25) {
      if (currentName === clipName) return;
      const clip = THREE.AnimationClip.findByName(g.animations, clipName);
      if (!clip) return;
      const a = mixer.clipAction(clip);
      a.reset().setEffectiveWeight(1).fadeIn(current ? fade : 0).play();
      if (current) current.fadeOut(fade);
      current = a; currentName = clipName;
    },
    setTime(t) { mixer.setTime(t); },
    dispose() { mixers.delete(api); mixer.stopAllAction(); },
  };
  mixers.add(api);
  return api;
}

export function updateMixers(dt, filter) {
  mixers.forEach(m => { if (m.active && (!filter || filter(m))) m.mixer.update(dt); });
}
