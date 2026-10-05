// Artwork geometry. All positions are in "artwork units": the artwork is
// 1 unit tall and `artW` units wide, origin top-left. The same layout drives
// the preview, thumbnails, tiled print exports and video, so what you see is
// exactly what is printed.

export const ASPECTS = {
  original: null,
  '1:1': 1,
  '4:5': 4 / 5,
  '5:4': 5 / 4,
  '2:3': 2 / 3,
  '3:2': 3 / 2,
  '3:4': 3 / 4,
  '4:3': 4 / 3,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  'A (1:√2)': 1 / Math.SQRT2,
  'A landscape': Math.SQRT2,
  '5:7': 5 / 7,
  '7:5': 7 / 5,
  '21:9': 21 / 9,
  phone: 1290 / 2796,
};

// frame: { aspect, fit: 'crop'|'contain', zoom, cx, cy, border, borderBottom }
// sig:   { on, text, size, position }
export function computeLayout(frame, srcW, srcH, sig) {
  const Ai = srcW / srcH;
  const b = Math.max(0, frame.border || 0);
  const bb = Math.max(0, frame.borderBottom || 0);
  let artW;
  const target = ASPECTS[frame.aspect] ?? (typeof frame.aspect === 'number' ? frame.aspect : null);
  if (target) artW = target;
  else {
    // "original": choose the outer aspect so the inner image area keeps the photo's aspect
    artW = Ai;
    for (let i = 0; i < 30; i++) {
      const bn = b * Math.min(artW, 1);
      const h = 1 - 2 * bn - bb;
      artW = Ai * h + 2 * bn;
    }
  }
  const bn = b * Math.min(artW, 1);
  const inner = { x: bn, y: bn, w: Math.max(1e-3, artW - 2 * bn), h: Math.max(1e-3, 1 - 2 * bn - bb) };
  const Ar = inner.w / inner.h;
  let imgRect, srcRect;
  const zoom = Math.max(1, frame.zoom || 1);
  if (frame.fit === 'contain' && target) {
    // whole photo, letterboxed inside the inner area
    let w = inner.w, h = inner.w / Ai;
    if (h > inner.h) { h = inner.h; w = h * Ai; }
    imgRect = { x: inner.x + (inner.w - w) / 2, y: inner.y + (inner.h - h) / 2, w, h };
    srcRect = { x: 0, y: 0, w: 1, h: 1 };
  } else {
    imgRect = inner;
    // largest source window of aspect Ar, shrunk by zoom, centred on (cx, cy)
    let sw = 1, sh = 1;
    if (Ar > Ai) sh = Ai / Ar; else sw = Ar / Ai;
    sw /= zoom; sh /= zoom;
    const cx = clamp(frame.cx ?? 0.5, sw / 2, 1 - sw / 2);
    const cy = clamp(frame.cy ?? 0.5, sh / 2, 1 - sh / 2);
    srcRect = { x: cx - sw / 2, y: cy - sh / 2, w: sw, h: sh };
  }
  let sigRect = null;
  if (sig && sig.on && sig.text) {
    const hgt = (sig.size || 2.2) / 100; // percent of artwork height
    const inBorder = bb + bn >= hgt * 1.5;
    const pos = sig.position || 'br';
    let y;
    if (pos[0] === 't') y = inBorder && bn >= hgt * 1.5 ? (bn - hgt) / 2 : imgRect.y + hgt * 0.8;
    else y = inBorder ? imgRect.y + imgRect.h + (1 - imgRect.y - imgRect.h - hgt) / 2 : imgRect.y + imgRect.h - hgt * 1.8;
    sigRect = { y, h: hgt, anchor: pos[1], inBorder, margin: inBorder ? imgRect.x : imgRect.x + hgt * 0.8, right: inBorder ? imgRect.x + imgRect.w : imgRect.x + imgRect.w - hgt * 0.8 };
  }
  return { artW, imgRect, srcRect, sigRect };
}

// pixel size of an export for a given output height or width
export function outputSize(layout, { width, height, longEdge }) {
  const a = layout.artW;
  if (longEdge) return a >= 1 ? { w: longEdge, h: Math.round(longEdge / a) } : { w: Math.round(longEdge * a), h: longEdge };
  if (width) return { w: width, h: Math.round(width / a) };
  return { w: Math.round(height * a), h: height };
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
