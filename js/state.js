// Artwork settings: defaults, highlighters, built-in looks.

let uid = 1;
export const newId = () => `h${Date.now().toString(36)}${(uid++).toString(36)}`;

export function newHighlighter(over = {}) {
  return {
    id: newId(),
    name: 'Highlighter',
    on: true,
    center: 0.35,     // distance (0 near … 1 far)
    width: 0.03,      // band width in depth units
    feather: 0.012,   // soft edge
    glow: 0,          // depth-space halo amount
    glowRadius: 0.05,
    style: 'solid',   // solid | photo | line
    blend: 'screen',  // screen | normal | add | multiply
    color: '#ffffff',
    intensity: 1,
    opacity: 1,
    detail: 0.35,     // photo texture inside the band
    tint: 0,          // photo style: colour tint
    thickness: 1.2,   // line style: per-mille of artwork height
    ...over,
  };
}

export function defaultSettings() {
  return {
    v: 1,
    depth: { near: 0, far: 1, gamma: 1, invert: false, edgeClean: 0.85 },
    base: { near: '#000000', mid: '#000000', far: '#000000', midPos: 0.5, curve: 1, photo: 0, photoSat: 0, detail: 0 },
    relief: { amount: 0, angle: 135, radius: 2 },
    contours: { on: false, count: 16, thickness: 0.8, opacity: 0.6, color: '#ffffff' },
    highlighters: [newHighlighter({ name: 'Subject' })],
    finish: { exposure: 1, contrast: 1, saturation: 1, vignette: 0, grain: 0, grainSize: 1, seed: 0 },
    frame: { aspect: 'original', fit: 'crop', zoom: 1, cx: 0.5, cy: 0.5, border: 0, borderBottom: 0, borderColor: '#ffffff' },
    signature: { on: false, text: '', font: 'Cormorant Garamond', size: 2.2, position: 'br', color: '#ffffff', opacity: 0.85, italic: true, spacing: 0.08 },
    anim: { mode: 'sweep', target: 'all', from: 0.05, to: 0.9, range: 0.12, duration: 6, loop: 'pingpong', cycles: 2 },
  };
}

// merge a partial settings object over defaults (also upgrades old saves)
export function normalize(s) {
  const d = defaultSettings();
  const out = { ...d };
  for (const k of Object.keys(d)) {
    if (k === 'highlighters' || k === 'v') continue;
    out[k] = { ...d[k], ...(s?.[k] || {}) };
  }
  out.highlighters = (s?.highlighters || d.highlighters).map((h) => newHighlighter({ ...h, id: h.id || newId() }));
  return out;
}

const H = newHighlighter;
// Looks: `center: 'auto:k'` resolves to the k-th detected subject plane of
// the current photo, so every look lands on something in any picture.
export const LOOKS = [
  {
    name: 'Single Plane', desc: 'One thin slice of distance, white on black',
    s: { base: { near: '#000000', mid: '#000000', far: '#000000' }, highlighters: [H({ name: 'Plane', center: 'auto:0', width: 0.025, feather: 0.01, detail: 0.45 })] },
  },
  {
    name: 'Mist', desc: 'Near dark, distance pale like fog',
    s: { base: { near: '#0b0b0c', mid: '#5c5d60', far: '#ecebe7', midPos: 0.55, curve: 0.85, detail: 0.15 }, highlighters: [] },
  },
  {
    name: 'Three Distances', desc: 'Three planes fading with depth',
    s: {
      base: { near: '#000000', mid: '#000000', far: '#000000' },
      highlighters: [
        H({ name: 'Near', center: 'auto:0', width: 0.03, intensity: 1, detail: 0.4 }),
        H({ name: 'Middle', center: 'auto:1', width: 0.025, intensity: 0.72, detail: 0.4 }),
        H({ name: 'Far', center: 'auto:2', width: 0.02, intensity: 0.45, detail: 0.4 }),
      ],
    },
  },
  {
    name: 'Mist + Plane', desc: 'Atmospheric gradient with one glowing subject',
    s: {
      base: { near: '#050506', mid: '#2a2b2e', far: '#9fa0a3', midPos: 0.6, curve: 1.1, detail: 0.2 },
      highlighters: [H({ name: 'Subject', center: 'auto:0', width: 0.035, glow: 0.25, glowRadius: 0.04, detail: 0.5 })],
    },
  },
  {
    name: 'Strata', desc: 'Evenly sliced space, like a contour scan',
    s: {
      base: { near: '#000000', mid: '#000000', far: '#000000' },
      contours: { on: true, count: 28, thickness: 0.7, opacity: 0.55, color: '#ffffff' },
      highlighters: [H({ name: 'Subject', center: 'auto:0', width: 0.03, detail: 0.3 })],
    },
  },
  {
    name: 'Ghost Photo', desc: 'The photograph shows only at chosen distances',
    s: {
      base: { near: '#000000', mid: '#000000', far: '#000000', photo: 0.08, photoSat: 0 },
      highlighters: [
        H({ name: 'Reveal', center: 'auto:0', width: 0.06, feather: 0.025, style: 'photo', blend: 'normal', intensity: 1.05 }),
        H({ name: 'Edge', center: 'auto:0', style: 'line', thickness: 1, color: '#ffffff', opacity: 0.7 }),
      ],
    },
  },
  {
    name: 'Neon Depth', desc: 'Coloured light planes with depth glow',
    s: {
      base: { near: '#05050c', mid: '#080a1c', far: '#141a3a', midPos: 0.5, detail: 0.25 },
      highlighters: [
        H({ name: 'Magenta', center: 'auto:0', width: 0.02, glow: 0.35, glowRadius: 0.03, color: '#ff2fa3', detail: 0.3 }),
        H({ name: 'Cyan', center: 'auto:1', width: 0.02, glow: 0.35, glowRadius: 0.03, color: '#2fe6ff', detail: 0.3 }),
        H({ name: 'Amber', center: 'auto:2', width: 0.02, glow: 0.35, glowRadius: 0.03, color: '#ffb02f', detail: 0.3 }),
      ],
      finish: { grain: 0.25, vignette: 0.35 },
    },
  },
  {
    name: 'Relief', desc: 'The depth surface lit like a plaster cast',
    s: {
      base: { near: '#d8d6d1', mid: '#b9b7b2', far: '#8d8b87', detail: 0 },
      relief: { amount: 0.9, angle: 135, radius: 2 },
      highlighters: [H({ name: 'Warm plane', center: 'auto:0', width: 0.03, color: '#ffcf8a', blend: 'multiply', detail: 0 })],
    },
  },
  {
    name: 'Night Fog', desc: 'Inverted mist: the near world glows',
    s: {
      base: { near: '#e9e7e2', mid: '#3d3e42', far: '#030304', midPos: 0.35, curve: 1, detail: 0.2 },
      highlighters: [H({ name: 'Line', center: 'auto:1', style: 'line', thickness: 1.6, color: '#ffffff' })],
      finish: { grain: 0.3 },
    },
  },
  {
    name: 'Topographic', desc: 'Iso-depth lines on paper, a red survey line',
    s: {
      base: { near: '#efe9dd', mid: '#efe9dd', far: '#efe9dd', detail: 0.08 },
      contours: { on: true, count: 32, thickness: 0.6, opacity: 0.75, color: '#4a3b2c' },
      highlighters: [H({ name: 'Survey', center: 'auto:0', style: 'line', thickness: 2.2, color: '#c8321e', blend: 'normal' })],
      finish: { grain: 0.15 },
    },
  },
  {
    name: 'Blueprint', desc: 'White lines on cyanotype blue',
    s: {
      base: { near: '#123a6b', mid: '#0f3260', far: '#0b2a52', detail: 0.12 },
      relief: { amount: 0.25, angle: 120, radius: 2 },
      contours: { on: true, count: 20, thickness: 0.6, opacity: 0.5, color: '#dbe9ff' },
      highlighters: [H({ name: 'Plane', center: 'auto:0', width: 0.02, color: '#ffffff', detail: 0.2 })],
    },
  },
  {
    name: 'Ink', desc: 'Black planes printed on white',
    s: {
      base: { near: '#f6f4ef', mid: '#f6f4ef', far: '#f6f4ef' },
      highlighters: [
        H({ name: 'Near', center: 'auto:0', width: 0.03, color: '#000000', blend: 'multiply', detail: 0.35 }),
        H({ name: 'Far', center: 'auto:2', width: 0.02, color: '#5a5a5a', blend: 'multiply', detail: 0.35 }),
      ],
      finish: { grain: 0.2 },
    },
  },
];

// apply a look: keep frame + signature + depth remap, replace the creative part
export function applyLook(cur, look, peaks) {
  const s = normalize({ ...cur, base: undefined, relief: undefined, contours: undefined, finish: { seed: cur.finish.seed }, highlighters: [] });
  const L = look.s;
  for (const k of ['base', 'relief', 'contours', 'finish']) if (L[k]) s[k] = { ...s[k], ...L[k] };
  s.highlighters = (L.highlighters || []).map((h) => {
    const c = typeof h.center === 'string' ? resolveAuto(h.center, peaks) : h.center;
    return newHighlighter({ ...h, id: newId(), center: c });
  });
  return s;
}

export function resolveAuto(spec, peaks) {
  const k = parseInt(spec.split(':')[1], 10) || 0;
  const sorted = [...(peaks || [])].sort((a, b) => a - b);
  if (sorted.length > k) return sorted[k];
  const fallback = [0.25, 0.5, 0.75];
  return fallback[k] ?? 0.5;
}
