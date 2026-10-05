// Edge-aware depth upsampling: a colour-guided filter (He et al.) snaps the
// coarse network depth to the photo's edges at an intermediate resolution,
// then joint bilateral upsampling carries it to full resolution. So
// highlighter bands cut cleanly around hair, branches and silhouettes even
// on a 40-megapixel print.
//
// in:  { full: {w,h,data:Uint8ClampedArray RGBA}, low: {w,h,data}, depth: {w,h,data:Float32Array}, radius, eps }
// out: { w, h, data: Float32Array }

function box(src, w, h, r, out) {
  const tmp = new Float32Array(w * h);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + (x < 0 ? 0 : x >= w ? w - 1 : x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * k;
      const xa = x + r + 1, xr = x - r;
      acc += src[row + (xa >= w ? w - 1 : xa)] - src[row + (xr < 0 ? 0 : xr)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * k;
      const ya = y + r + 1, yr = y - r;
      acc += tmp[(ya >= h ? h - 1 : ya) * w + x] - tmp[(yr < 0 ? 0 : yr) * w + x];
    }
  }
  return out;
}

function resize(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5));
    const y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5));
      const x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      out[y * dw + x] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
    }
  }
  return out;
}

self.onmessage = (e) => {
  try {
    const { full, low, depth, radius, eps } = e.data;
    const w = low.w, h = low.h, n = w * h;
    const post = (p, stage) => self.postMessage({ progress: p, stage });
    post(0.05, 'Snapping depth to photo edges…');
    const p = resize(depth.data, depth.w, depth.h, w, h);
    const I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) I[c][i] = low.data[i * 4 + c] / 255;
    const r = Math.max(1, radius | 0);
    const mI = I.map((ch) => box(ch, w, h, r, new Float32Array(n)));
    const mP = box(p, w, h, r, new Float32Array(n));
    const tmp = new Float32Array(n);
    const prod = (a, b) => { for (let i = 0; i < n; i++) tmp[i] = a[i] * b[i]; return box(tmp, w, h, r, new Float32Array(n)); };
    const cIp = I.map((ch) => prod(ch, p));
    post(0.3);
    const pairs = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
    const V = pairs.map(([a, b]) => prod(I[a], I[b]));
    post(0.5);
    const a0 = new Float32Array(n), a1 = new Float32Array(n), a2 = new Float32Array(n), bb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const m0 = mI[0][i], m1 = mI[1][i], m2 = mI[2][i], mp = mP[i];
      const c0 = cIp[0][i] - m0 * mp, c1 = cIp[1][i] - m1 * mp, c2 = cIp[2][i] - m2 * mp;
      const s00 = V[0][i] - m0 * m0 + eps, s01 = V[1][i] - m0 * m1, s02 = V[2][i] - m0 * m2;
      const s11 = V[3][i] - m1 * m1 + eps, s12 = V[4][i] - m1 * m2, s22 = V[5][i] - m2 * m2 + eps;
      // inverse of the symmetric 3×3 covariance
      const i00 = s11 * s22 - s12 * s12, i01 = s02 * s12 - s01 * s22, i02 = s01 * s12 - s02 * s11;
      const i11 = s00 * s22 - s02 * s02, i12 = s01 * s02 - s00 * s12, i22 = s00 * s11 - s01 * s01;
      const det = s00 * i00 + s01 * i01 + s02 * i02;
      const inv = 1 / (Math.abs(det) < 1e-18 ? 1e-18 : det);
      const x0 = (i00 * c0 + i01 * c1 + i02 * c2) * inv;
      const x1 = (i01 * c0 + i11 * c1 + i12 * c2) * inv;
      const x2 = (i02 * c0 + i12 * c1 + i22 * c2) * inv;
      a0[i] = x0; a1[i] = x1; a2[i] = x2;
      bb[i] = mp - x0 * m0 - x1 * m1 - x2 * m2;
    }
    post(0.65);
    const A0 = box(a0, w, h, r, new Float32Array(n)), A1 = box(a1, w, h, r, new Float32Array(n)), A2 = box(a2, w, h, r, new Float32Array(n)), Bm = box(bb, w, h, r, new Float32Array(n));
    // snapped depth at the guide resolution
    const qL = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = A0[i] * I[0][i] + A1[i] * I[1][i] + A2[i] * I[2][i] + Bm[i]; qL[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
    post(0.75, 'Rendering full-resolution depth…');
    // Joint bilateral upsampling to full resolution: every output value is a
    // weighted average of nearby snapped depths, weighted by colour similarity
    // to the full-resolution photo. Flat areas stay perfectly flat (no photo
    // grain is copied into the depth), edges follow the full-res photo.
    const W = full.w, H = full.h, q = new Float32Array(W * H), F = full.data, L8 = low.data;
    const RL = new Float32Array(1024);
    const sr = 0.1; // colour sigma
    for (let k = 0; k < 1024; k++) RL[k] = Math.exp(-(k / 1023 * 3) / (2 * sr * sr));
    const SL = new Float32Array(64);
    for (let k = 0; k < 64; k++) { const d2 = k / 63 * 8; SL[k] = Math.exp(-d2 / (2 * 0.75 * 0.75)); }
    for (let y = 0; y < H; y++) {
      const fy = (y + 0.5) * h / H - 0.5, cy = Math.round(fy);
      for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) * w / W - 0.5, cx = Math.round(fx);
        const o = (y * W + x) * 4, r = F[o], g = F[o + 1], b = F[o + 2];
        let acc = 0, wsum = 0;
        for (let j = -1; j <= 1; j++) {
          const yy = cy + j < 0 ? 0 : cy + j >= h ? h - 1 : cy + j;
          const dy = yy - fy;
          for (let i = -1; i <= 1; i++) {
            const xx = cx + i < 0 ? 0 : cx + i >= w ? w - 1 : cx + i;
            const dx = xx - fx;
            const sd = (dx * dx + dy * dy) * 7.875; // → 0..63 for d² ≤ 8
            const li = (yy * w + xx), lo = li * 4;
            const er = (r - L8[lo]) / 255, eg = (g - L8[lo + 1]) / 255, eb = (b - L8[lo + 2]) / 255;
            const cd = (er * er + eg * eg + eb * eb) * 341; // → 0..1023 for d² ≤ 3
            const wt = SL[sd > 63 ? 63 : sd | 0] * RL[cd > 1023 ? 1023 : cd | 0] + 1e-6;
            acc += qL[li] * wt; wsum += wt;
          }
        }
        q[y * W + x] = acc / wsum;
      }
      if ((y & 255) === 0) post(0.75 + 0.25 * y / H);
    }
    self.postMessage({ done: true, w: W, h: H, data: q }, [q.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
