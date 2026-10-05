// Monocular depth estimation in the browser with Depth Anything V2
// (transformers.js + ONNX Runtime, WebGPU when available, else WebAssembly).
// Models download once from Hugging Face and are cached by the browser.
//
// Output convention used everywhere in the app: a Float32Array where
// 0 = nearest and 1 = farthest point of the scene.

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/transformers.min.js';

export const MODELS = {
  small: { id: 'onnx-community/depth-anything-v2-small', label: 'Depth Anything V2 Small (fast, ~27–99 MB)' },
  base: { id: 'onnx-community/depth-anything-v2-base', label: 'Depth Anything V2 Base (best detail, ~100–390 MB)' },
};

export const DETAIL = {
  standard: { label: 'Standard (518 px)', sizes: [518] },
  high: { label: 'High (812 px)', sizes: [812] },
  ultra: { label: 'Ultra (518 + 1022 px fused)', sizes: [518, 1022] },
};

let lib = null;
const loaded = new Map();

async function backend() {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
    } catch { /* fall through */ }
  }
  return { device: 'wasm', dtype: 'q8' };
}

// mobile networks drop requests: retry downloads a few times before giving up
async function retry(fn, onProgress, n = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(i); } catch (e) {
      if (i >= n || !/fetch|network|load|abort/i.test(e?.message || String(e))) throw e;
      onProgress?.({ stage: `Connection problem, retrying (${i}/${n - 1})…` });
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function getModel(key, onProgress) {
  if (!lib) {
    onProgress?.({ stage: 'Loading AI runtime…' });
    lib = await retry((i) => import(TRANSFORMERS + (i > 1 ? `?retry=${i}` : '')), onProgress); // a failed import is cached per URL
    lib.env.allowLocalModels = false;
  }
  if (loaded.has(key)) return loaded.get(key);
  const be = await backend();
  const files = new Map();
  const progress_callback = (e) => {
    if (e.status === 'progress' && e.total) {
      files.set(e.file, [e.loaded, e.total]);
      let a = 0, b = 0;
      for (const [l, t] of files.values()) { a += l; b += t; }
      onProgress?.({ stage: `Downloading depth model (${(b / 1e6).toFixed(0)} MB, once)…`, progress: a / b });
    }
  };
  let model;
  try {
    model = await retry(() => lib.AutoModel.from_pretrained(MODELS[key].id, { device: be.device, dtype: be.dtype, progress_callback }), onProgress);
  } catch (e) {
    if (be.device !== 'webgpu') throw e;
    console.warn('WebGPU failed, falling back to WebAssembly', e);
    be.device = 'wasm'; be.dtype = 'q8';
    model = await retry(() => lib.AutoModel.from_pretrained(MODELS[key].id, { device: 'wasm', dtype: 'q8', progress_callback }), onProgress);
  }
  const entry = { model, backend: be };
  loaded.set(key, entry);
  return entry;
}

// run the network at a given long-edge size; returns disparity (higher = nearer)
async function infer(model, bitmap, longEdge) {
  const ar = bitmap.width / bitmap.height;
  const m14 = (v) => Math.max(14, Math.round(v / 14) * 14);
  const W = ar >= 1 ? m14(longEdge) : m14(longEdge * ar);
  const H = ar >= 1 ? m14(longEdge / ar) : m14(longEdge);
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const N = W * H, data = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) data[k * N + i] = (px[i * 4 + k] / 255 - mean[k]) / std[k];
  const input = new lib.Tensor('float32', data, [1, 3, H, W]);
  const out = await model({ pixel_values: input });
  const t = out.predicted_depth;
  const dims = t.dims;
  const h = dims[dims.length - 2], w = dims[dims.length - 1];
  return { data: Float32Array.from(t.data), w, h };
}

// bilinear resize of a single-channel float image
export function resizeFloat(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Float32Array.from(src);
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// robust normalisation of disparity → depth 0 (near) … 1 (far)
export function normalizeDisparity(data, { lo = 0.002, hi = 0.998, isDepth = false } = {}) {
  const step = Math.max(1, Math.floor(data.length / 200000));
  const sample = [];
  for (let i = 0; i < data.length; i += step) if (Number.isFinite(data[i])) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  const a = sample[Math.floor(lo * (sample.length - 1))], b = sample[Math.floor(hi * (sample.length - 1))];
  const out = new Float32Array(data.length), span = Math.max(1e-9, b - a);
  for (let i = 0; i < data.length; i++) {
    const n = Math.min(1, Math.max(0, (data[i] - a) / span));
    out[i] = isDepth ? n : 1 - n;
  }
  return out;
}

// Estimate depth for a photo. Returns { data, w, h } at the network's resolution.
export async function estimateDepth(bitmap, { model = 'small', detail = 'standard' } = {}, onProgress) {
  const { model: net, backend: be } = await getModel(model, onProgress);
  const sizes = DETAIL[detail]?.sizes || [518];
  const runs = [];
  for (const s of sizes) {
    onProgress?.({ stage: `Estimating depth at ${s} px on ${be.device === 'webgpu' ? 'GPU' : 'CPU'}…`, progress: null });
    runs.push(await infer(net, bitmap, s));
  }
  if (runs.length === 1) {
    const r = runs[0];
    return { data: normalizeDisparity(r.data), w: r.w, h: r.h, backend: be.device };
  }
  // fusion: global structure from the low-res pass, fine detail from the high-res pass
  onProgress?.({ stage: 'Fusing detail…', progress: null });
  const [lo, hi] = runs;
  const W = hi.w, H = hi.h;
  const L = resizeFloat(lo.data, lo.w, lo.h, W, H);
  // least-squares align hi to lo (scale + shift)
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const n = W * H;
  for (let i = 0; i < n; i++) { const x = hi.data[i], y = L[i]; sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const k = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx), c = (sy - k * sx) / n;
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) A[i] = hi.data[i] * k + c;
  const r = Math.max(2, Math.round(W / 518 * 6));
  const lb = boxBlur(boxBlur(L, W, H, r), W, H, r), hb = boxBlur(boxBlur(A, W, H, r), W, H, r);
  const F = new Float32Array(n);
  for (let i = 0; i < n; i++) F[i] = lb[i] + (A[i] - hb[i]);
  return { data: normalizeDisparity(F), w: W, h: H, backend: be.device };
}
