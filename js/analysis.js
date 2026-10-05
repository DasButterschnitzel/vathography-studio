// Depth statistics: the histogram behind the depth ruler and a subject
// finder that proposes the distances worth highlighting.

export function histogram(data, w, h, remap, bins = 256) {
  const hist = new Float32Array(bins);
  const step = Math.max(1, Math.floor(Math.sqrt(w * h / 250000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const d = remap(data[y * w + x]);
      hist[Math.min(bins - 1, Math.max(0, Math.floor(d * bins)))] += 1;
    }
  }
  return hist;
}

// Subject finder. Two weighted histograms:
//  - surfaces: central, nearer, fronto-parallel areas (people, trees, facades)
//    rather than receding ground or the far background
//  - figures: such surfaces that also stand in front of something farther
//    above them (a person against the landscape, a boat on the water)
// Figures are proposed first even when they are small.
export function subjectPeaks(data, w, h, remap, n = 3, bins = 256) {
  const surf = new Float32Array(bins), fig = new Float32Array(bins);
  const step = Math.max(1, Math.floor(Math.sqrt(w * h / 250000)));
  const up = Math.max(step, Math.round(h * 0.05));
  let samples = 0, figMass = 0;
  for (let y = 0; y < h; y += step) {
    const ny = y / h - 0.5;
    for (let x = 0; x < w; x += step) {
      samples++;
      const d = remap(data[y * w + x]);
      const nx = x / w - 0.5;
      let wt = Math.exp(-(nx * nx + ny * ny) / (2 * 0.3 * 0.3)) * (1.3 - d);
      const xr = Math.min(w - 1, x + step), yd = Math.min(h - 1, y + step);
      const g = Math.max(Math.abs(remap(data[y * w + xr]) - d), Math.abs(remap(data[yd * w + x]) - d)) / (step / h);
      wt *= Math.exp(-(g / 0.5) * (g / 0.5));
      const b = Math.min(bins - 1, Math.max(0, Math.floor(d * bins)));
      surf[b] += wt;
      if (y >= up) {
        const above = remap(data[(y - up) * w + x]);
        const f = Math.min(1, Math.max(0, (above - d - 0.04) / 0.12));
        if (f > 0 && d < 0.9) { fig[b] += wt * f; figMass += f; }
      }
    }
  }
  const out = [];
  if (figMass > samples * 0.002) out.push(...findPeaks(fig, 1, false));
  for (const p of findPeaks(surf, n + 2, false)) {
    if (out.length >= n) break;
    if (out.every((q) => Math.abs(q - p) > 0.06)) out.push(p);
  }
  if (out.length < n) for (const p of findPeaks(histogram(data, w, h, remap, bins), n)) if (out.length < n && out.every((q) => Math.abs(q - p) > 0.06)) out.push(p);
  return out.slice(0, n).sort((a, b) => a - b);
}

function smooth(hist, sigma) {
  const n = hist.length, r = Math.ceil(sigma * 3), out = new Float32Array(n);
  const k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < n; i++) {
    let a = 0, b = 0;
    for (let j = -r; j <= r; j++) { const t = i + j; if (t < 0 || t >= n) continue; a += hist[t] * k[j + r]; b += k[j + r]; }
    out[i] = a / b;
  }
  return out;
}

// returns up to n depth values (ascending) of prominent "subject planes"
export function findPeaks(hist, n = 3, fill = true) {
  const bins = hist.length;
  const s = smooth(hist, bins / 96);
  let max = 0;
  for (const v of s) max = Math.max(max, v);
  const peaks = [];
  for (let i = 1; i < bins - 1; i++) {
    if (!(s[i] > s[i - 1] && s[i] >= s[i + 1])) continue;
    let l = s[i], r = s[i];
    for (let j = i - 1; j >= 0 && s[j] <= s[i]; j--) l = Math.min(l, s[j]);
    for (let j = i + 1; j < bins && s[j] <= s[i]; j++) r = Math.min(r, s[j]);
    const prom = s[i] - Math.max(l, r);
    const d = (i + 0.5) / bins;
    // the far background (sky, infinity) is rarely the subject
    const score = prom * (d > 0.95 ? 0.25 : 1) * (d < 0.02 ? 0.5 : 1);
    if (prom > max * 0.03) peaks.push({ d, score });
  }
  peaks.sort((a, b) => b.score - a.score);
  const out = [];
  for (const p of peaks) {
    if (out.every((q) => Math.abs(q - p.d) > 0.06)) out.push(p.d);
    if (out.length >= n) break;
  }
  // fill with weighted quantiles so there are always n proposals
  if (fill && out.length < n) {
    let total = 0;
    for (const v of hist) total += v;
    for (const q of [0.3, 0.55, 0.8, 0.15, 0.68]) {
      if (out.length >= n) break;
      let acc = 0, i = 0;
      for (; i < bins; i++) { acc += hist[i]; if (acc >= total * q) break; }
      const d = (i + 0.5) / bins;
      if (out.every((x) => Math.abs(x - d) > 0.06)) out.push(d);
    }
  }
  return out.sort((a, b) => a - b);
}
