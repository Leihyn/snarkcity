// Visual styles for the city. /?style=<name> loads themes/<name>.css and the
// scene palette in themes/<name>.js; without it the city keeps this default.
// Only colours, light and type change: the city and its data stay the same.

export const DEFAULT = {
  sky: '#1B2233', fogNear: 140, fogFar: 320,
  hemiSky: '#C8D6FF', hemiGround: '#2B2F38', hemi: 0.95,
  sun: '#FFE2B8', sunIntensity: 1.7,
  ground: '#3B414E', block: '#B4B6BB', plaza: '#CFC8B8', plinth: '#2A3242', lawn: '#6F8F62',
  accent: '#F2B33D', // tower crowns, crane, plaza ring, sign stripe
  pad: '#9A9C9F', pole: '#C9CCD2', puff: '#E4E8F0', puffOpacity: 0.8,
  towerBase: '#8A9AB4', windowLit: '#FFE3A1', windowGlow: '#FFC86A', windowDark: '#2A3446', roof: '#55617A',
  signBg: '#141A26', signText: '#F4EFE3',
  signFont: '"Big Shoulders Display", "Arial Narrow", Arial, sans-serif',
  signMono: '"IBM Plex Mono", Menlo, monospace',
  tint: null, // multiplies the colours of the filler buildings, e.g. '#FFE9D0'
};

export const STYLES = ['plinth', 'trimmy', 'w3f'];
export let T = DEFAULT;

export async function loadTheme() {
  const name = new URLSearchParams(location.search).get('style');
  if (!STYLES.includes(name)) return T;
  // The stylesheet goes first: a style may wait for its fonts while loading.
  const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `themes/${name}.css` });
  document.head.append(link);
  document.documentElement.dataset.style = name;
  try {
    const { palette } = await import(`../themes/${name}.js`);
    T = { ...DEFAULT, ...palette };
  } catch (e) {
    console.warn(`style "${name}" is not available here; using the default look`, e);
    link.remove();
    delete document.documentElement.dataset.style;
  }
  return T;
}
