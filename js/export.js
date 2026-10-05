// Export: tiled rendering for prints of any size, social formats, depth maps,
// and depth-sweep videos for Reels/TikTok/Shorts.
import { writePNG, writeTIFF, BlobSink, FileSink } from './codecs.js';

export const PRINT_SIZES = [
  { id: 'a4', label: 'A4 · 21 × 29.7 cm', w: 21, h: 29.7 },
  { id: 'a3', label: 'A3 · 29.7 × 42 cm', w: 29.7, h: 42 },
  { id: 'a2', label: 'A2 · 42 × 59.4 cm', w: 42, h: 59.4 },
  { id: 'a1', label: 'A1 · 59.4 × 84.1 cm', w: 59.4, h: 84.1 },
  { id: 'a0', label: 'A0 · 84.1 × 118.9 cm', w: 84.1, h: 118.9 },
  { id: '30x40', label: '30 × 40 cm', w: 30, h: 40 },
  { id: '40x50', label: '40 × 50 cm', w: 40, h: 50 },
  { id: '50x70', label: '50 × 70 cm', w: 50, h: 70 },
  { id: '60x90', label: '60 × 90 cm', w: 60, h: 90 },
  { id: '70x100', label: '70 × 100 cm', w: 70, h: 100 },
  { id: '100x150', label: '100 × 150 cm', w: 100, h: 150 },
  { id: '8x10', label: '8 × 10 in', w: 20.32, h: 25.4 },
  { id: '11x14', label: '11 × 14 in', w: 27.94, h: 35.56 },
  { id: '16x20', label: '16 × 20 in', w: 40.64, h: 50.8 },
  { id: '20x30', label: '20 × 30 in', w: 50.8, h: 76.2 },
  { id: '24x36', label: '24 × 36 in', w: 60.96, h: 91.44 },
  { id: '40x60', label: '40 × 60 in', w: 101.6, h: 152.4 },
];

export const SOCIAL = [
  { id: 'ig-portrait', label: 'Instagram portrait 4:5 · 1080 × 1350', aspect: '4:5', w: 1080 },
  { id: 'ig-square', label: 'Instagram square · 1080 × 1080', aspect: '1:1', w: 1080 },
  { id: 'story', label: 'Story / Reel / TikTok 9:16 · 1080 × 1920', aspect: '9:16', w: 1080 },
  { id: 'ig-portrait-hi', label: 'Instagram portrait HD · 2160 × 2700', aspect: '4:5', w: 2160 },
  { id: 'x', label: 'X / LinkedIn landscape · 1600 × 900', aspect: '16:9', w: 1600 },
  { id: 'wallpaper-4k', label: '4K wallpaper · 3840 × 2160', aspect: '16:9', w: 3840 },
  { id: 'phone', label: 'Phone wallpaper · 1290 × 2796', aspect: 'phone', w: 1290 },
];

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// async generator of RGB strips, 8-bit or 16-bit
function stripSource(renderer, s, layout, w, h, bits, signal) {
  const float = bits === 16 && renderer.floatRT;
  const bytesPerPx = float ? 16 : 4;
  const tileW = Math.min(renderer.maxRB, w);
  const stripH = Math.max(8, Math.min(renderer.maxRB, h, Math.floor((48 << 20) / (Math.min(w, tileW) * bytesPerPx))));
  return async function* rows() {
    for (let y = 0; y < h; y += stripH) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const rh = Math.min(stripH, h - y);
      const out = bits === 16 ? new Uint16Array(w * rh * 3) : new Uint8Array(w * rh * 3);
      for (let x = 0; x < w; x += tileW) {
        const tw = Math.min(tileW, w - x);
        const px = renderer.renderRegion(s, layout, h, x, y, tw, rh, { float });
        for (let r = 0; r < rh; r++) {
          for (let c = 0; c < tw; c++) {
            const i = (r * tw + c) * 4, o = (r * w + x + c) * 3;
            if (bits === 16) {
              if (float) { out[o] = Math.round(Math.min(1, Math.max(0, px[i])) * 65535); out[o + 1] = Math.round(Math.min(1, Math.max(0, px[i + 1])) * 65535); out[o + 2] = Math.round(Math.min(1, Math.max(0, px[i + 2])) * 65535); }
              else { out[o] = px[i] * 257; out[o + 1] = px[i + 1] * 257; out[o + 2] = px[i + 2] * 257; }
            } else { out[o] = px[i]; out[o + 1] = px[i + 1]; out[o + 2] = px[i + 2]; }
          }
        }
      }
      yield { data: out, rows: rh };
      await nextFrame();
    }
  };
}

// opts: { w, h, format: png|png16|tiff|tiff16|jpeg, quality, dpi, filename, toDisk, text, onProgress, signal }
export async function exportImage(renderer, s, layout, opts) {
  const { w, h, format, dpi = 300, onProgress, signal } = opts;
  if (format === 'jpeg') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('This size is too large for JPEG in this browser — use PNG or TIFF.');
    const rows = stripSource(renderer, s, layout, w, h, 8, signal);
    let y = 0;
    for await (const strip of rows()) {
      const id = ctx.createImageData(w, strip.rows);
      for (let i = 0, j = 0; i < strip.data.length; i += 3, j += 4) { id.data[j] = strip.data[i]; id.data[j + 1] = strip.data[i + 1]; id.data[j + 2] = strip.data[i + 2]; id.data[j + 3] = 255; }
      ctx.putImageData(id, 0, y);
      y += strip.rows;
      onProgress?.(y / h * 0.9);
    }
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', opts.quality ?? 0.95));
    if (!blob) throw new Error('This size is too large for JPEG in this browser — use PNG or TIFF.');
    c.width = c.height = 1;
    return setJpegDpi(blob, dpi);
  }
  const bits = format.endsWith('16') ? 16 : 8;
  const tiff = format.startsWith('tiff');
  let sink;
  if (opts.toDisk && window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: opts.filename, types: [{ description: tiff ? 'TIFF image' : 'PNG image', accept: tiff ? { 'image/tiff': ['.tif', '.tiff'] } : { 'image/png': ['.png'] } }] });
    sink = new FileSink(await handle.createWritable());
  } else sink = new BlobSink(tiff ? 'image/tiff' : 'image/png');
  const rows = stripSource(renderer, s, layout, w, h, bits, signal);
  if (tiff) return writeTIFF({ width: w, height: h, bitDepth: bits, dpi, rows, sink, onProgress });
  return writePNG({ width: w, height: h, bitDepth: bits, dpi, rows, sink, onProgress, text: opts.text || {} });
}

// JFIF density in the APP0 segment so print software sees the DPI
async function setJpegDpi(blob, dpi) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[2] === 0xff && buf[3] === 0xe0 && buf[6] === 0x4a && buf[7] === 0x46) {
    buf[13] = 1;
    buf[14] = dpi >> 8; buf[15] = dpi & 255; buf[16] = dpi >> 8; buf[17] = dpi & 255;
  }
  return new Blob([buf], { type: 'image/jpeg' });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---- animation ------------------------------------------------------------
// anim: { mode: sweep|drift|breathe, target: highlighter id, from, to, range, duration, loop: pingpong|once }
export function animState(s, anim, t) {
  let ph = (t / Math.max(0.1, anim.duration)) % 1;
  if (anim.loop === 'once') ph = Math.min(1, t / Math.max(0.1, anim.duration));
  else ph = ph < 0.5 ? ph * 2 : 2 - ph * 2;
  const e = ph * ph * (3 - 2 * ph);
  const hl = s.highlighters;
  const off = hl.map(() => 0), wid = hl.map(() => 1);
  if (anim.mode === 'sweep') {
    hl.forEach((h, i) => { if (anim.target === 'all' || h.id === anim.target) off[i] = anim.from + (anim.to - anim.from) * e - (anim.target === 'all' ? hl[0].center : h.center); });
  } else if (anim.mode === 'drift') {
    hl.forEach((_, i) => { off[i] = (e - 0.5) * 2 * anim.range; });
  } else if (anim.mode === 'breathe') {
    hl.forEach((_, i) => { wid[i] = 0.25 + 1.5 * e; });
  }
  return { hlOffset: off, hlWidth: wid };
}

export function videoMime() {
  const c = ['video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1.4d0033', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || null;
}

// Records in real time from the renderer's canvas (the app resizes it first).
export async function recordVideo(renderer, s, layout, anim, { w, h, fps = 30, bitrate = 20e6, onProgress, signal }) {
  const mime = videoMime();
  if (!mime) throw new Error('Video recording is not supported in this browser (try Chrome or Edge).');
  const canvas = renderer.canvas;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise((r) => { rec.onstop = r; });
  const total = anim.loop === 'once' ? anim.duration : anim.duration * (anim.cycles || 2);
  const frames = Math.round(total * fps);
  rec.start(500);
  const t0 = performance.now();
  for (let f = 0; f <= frames; f++) {
    if (signal?.aborted) break;
    const t = f / fps;
    renderer.render(s, layout, { origin: [0, 0], px: 1 / h, mode: 0, split: -1, ...animState(s, anim, t) });
    track.requestFrame?.();
    onProgress?.(f / frames);
    const due = t0 + (f + 1) * 1000 / fps;
    await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
  }
  rec.stop();
  await stopped;
  track.stop();
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  return new Blob(parts, { type: mime.split(';')[0] });
}
