// Streaming image writers for print-size exports (PNG 8/16-bit with DPI,
// TIFF 8/16-bit with DPI) and a 16-bit PNG reader for imported depth maps.
// Rows arrive in strips, so a 140-megapixel A0 print never has to exist as
// one canvas in memory.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bufs) {
  let c = 0xffffffff;
  for (const b of bufs) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const enc = new TextEncoder();
function chunk(type, data) {
  const head = new Uint8Array(8), tail = new Uint8Array(4);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, data.length);
  const t = enc.encode(type);
  head.set(t, 4);
  new DataView(tail.buffer).setUint32(0, crc32([t, data]));
  return [head, data, tail];
}

// ---- sinks ----------------------------------------------------------------
export class BlobSink {
  constructor(type) { this.parts = []; this.type = type; this.size = 0; }
  async write(u8) { this.parts.push(u8.slice ? u8.slice() : u8); this.size += u8.length; }
  async close() { this.blob = new Blob(this.parts, { type: this.type }); this.parts = []; return this.blob; }
}
export class FileSink {
  constructor(writable) { this.w = writable; this.size = 0; this.buf = []; this.bufSize = 0; }
  async write(u8) {
    this.buf.push(u8.slice()); this.bufSize += u8.length; this.size += u8.length;
    if (this.bufSize > 8 << 20) await this.flush();
  }
  async flush() { if (this.buf.length) { await this.w.write(new Blob(this.buf)); this.buf = []; this.bufSize = 0; } }
  async close() { await this.flush(); await this.w.close(); return null; }
}

// ---- PNG writer -----------------------------------------------------------
// rows(): async iterator yielding { data: Uint8Array|Uint16Array (RGB interleaved), rows }
export async function writePNG({ width, height, bitDepth = 8, dpi = 300, text = {}, rows, sink, onProgress }) {
  const ch = 3, bps = bitDepth / 8, bpp = ch * bps, rowBytes = width * bpp;
  await sink.write(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = bitDepth; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  for (const c of chunk('IHDR', ihdr)) await sink.write(c);
  for (const c of chunk('sRGB', new Uint8Array([0]))) await sink.write(c);
  const phys = new Uint8Array(9), pv = new DataView(phys.buffer), ppm = Math.round(dpi / 0.0254);
  pv.setUint32(0, ppm); pv.setUint32(4, ppm); phys[8] = 1;
  for (const c of chunk('pHYs', phys)) await sink.write(c);
  for (const [k, v] of Object.entries(text)) {
    const kb = enc.encode(k), vb = enc.encode(v);
    const d = new Uint8Array(kb.length + 5 + vb.length); // iTXt: key\0 0 0 \0 \0 text
    d.set(kb, 0); d.set(vb, kb.length + 5);
    for (const c of chunk('iTXt', d)) await sink.write(c);
  }
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const pump = (async () => {
    let pend = [], size = 0;
    const flush = async () => {
      if (!size) return;
      const d = new Uint8Array(size);
      let o = 0;
      for (const p of pend) { d.set(p, o); o += p.length; }
      pend = []; size = 0;
      for (const c of chunk('IDAT', d)) await sink.write(c);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pend.push(value); size += value.length;
      if (size >= 1 << 20) await flush();
    }
    await flush();
  })();
  let prev = new Uint8Array(rowBytes), done = 0;
  for await (const strip of rows()) {
    const out = new Uint8Array(strip.rows * (rowBytes + 1));
    const cur = new Uint8Array(rowBytes);
    for (let r = 0; r < strip.rows; r++) {
      // serialise the row (16-bit big endian)
      if (bitDepth === 16) {
        const src = strip.data, base = r * width * ch;
        for (let i = 0; i < width * ch; i++) { const v = src[base + i]; cur[i * 2] = v >> 8; cur[i * 2 + 1] = v & 255; }
      } else cur.set(strip.data.subarray(r * rowBytes, (r + 1) * rowBytes));
      // Paeth filter
      const o = r * (rowBytes + 1);
      out[o] = 4;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out[o + 1 + i] = (cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      prev.set(cur);
    }
    await writer.write(out);
    done += strip.rows;
    onProgress?.(done / height);
  }
  await writer.close();
  await pump;
  for (const c of chunk('IEND', new Uint8Array(0))) await sink.write(c);
  return sink.close();
}

// ---- TIFF writer (baseline, uncompressed, one strip) ----------------------
export async function writeTIFF({ width, height, bitDepth = 8, dpi = 300, rows, sink, onProgress }) {
  const ch = 3, bps = bitDepth / 8, dataBytes = width * height * ch * bps;
  if (dataBytes > 0xfffffff0) throw new Error('Image too large for TIFF (over 4 GB). Use PNG.');
  const soft = enc.encode('Vathography Studio\0');
  const nTags = 13, ifdOff = 8, ifdSize = 2 + nTags * 12 + 4;
  let extra = ifdOff + ifdSize;
  const bpsOff = extra; extra += 6;
  const xresOff = extra; extra += 8;
  const yresOff = extra; extra += 8;
  const softOff = extra; extra += soft.length;
  extra += extra & 1;
  const dataOff = extra;
  const head = new Uint8Array(dataOff), dv = new DataView(head.buffer);
  head[0] = 0x49; head[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true);
  dv.setUint16(ifdOff, nTags, true);
  const tags = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, 3, bpsOff], [259, 3, 1, 1], [262, 3, 1, 2],
    [273, 4, 1, dataOff], [277, 3, 1, 3], [278, 4, 1, height], [279, 4, 1, dataBytes],
    [282, 5, 1, xresOff], [283, 5, 1, yresOff], [296, 3, 1, 2], [305, 2, soft.length, softOff],
  ];
  tags.forEach(([tag, type, count, val], i) => {
    const o = ifdOff + 2 + i * 12;
    dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true); dv.setUint32(o + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(o + 8, val, true); else dv.setUint32(o + 8, val, true);
  });
  dv.setUint32(ifdOff + 2 + nTags * 12, 0, true);
  for (let k = 0; k < 3; k++) dv.setUint16(bpsOff + k * 2, bitDepth, true);
  dv.setUint32(xresOff, Math.round(dpi * 100), true); dv.setUint32(xresOff + 4, 100, true);
  dv.setUint32(yresOff, Math.round(dpi * 100), true); dv.setUint32(yresOff + 4, 100, true);
  head.set(soft, softOff);
  await sink.write(head);
  let done = 0;
  for await (const strip of rows()) {
    if (bitDepth === 16) {
      const u = new Uint16Array(strip.data.length);
      u.set(strip.data); // little-endian on every platform browsers run on
      await sink.write(new Uint8Array(u.buffer));
    } else await sink.write(strip.data);
    done += strip.rows;
    onProgress?.(done / height);
  }
  return sink.close();
}

// ---- PNG reader (keeps 16-bit precision for depth maps) -------------------
export async function readPNGChannel(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (u8[0] !== 137 || u8[1] !== 80) return null;
  let o = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (o < u8.length) {
    const len = dv.getUint32(o), t = String.fromCharCode(...u8.subarray(o + 4, o + 8));
    const d = u8.subarray(o + 8, o + 8 + len);
    if (t === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    o += 12 + len;
  }
  const chans = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!chans || interlace || (depth !== 8 && depth !== 16)) return null;
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const bpp = chans * depth / 8, rb = w * bpp;
  const cur = new Uint8Array(rb), prev = new Uint8Array(rb);
  const out = new Float32Array(w * h);
  const max = depth === 16 ? 65535 : 255;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (rb + 1)], s = y * (rb + 1) + 1;
    for (let i = 0; i < rb; i++) {
      const x = raw[s + i], a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const k = x * bpp;
      out[y * w + x] = (depth === 16 ? (cur[k] << 8 | cur[k + 1]) : cur[k]) / max;
    }
    prev.set(cur);
  }
  return { w, h, data: out, bitDepth: depth };
}

// 16-bit grey PNG of a depth array (for saving projects and exporting depth maps)
export async function depthToPNG(data, w, h) {
  const sink = new BlobSink('image/png');
  const rb = w * 2;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await sink.write(sig);
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 16; ihdr[9] = 0;
  for (const c of chunk('IHDR', ihdr)) await sink.write(c);
  const raw = new Uint8Array(h * (rb + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (rb + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const v = Math.round(Math.min(1, Math.max(0, data[y * w + x])) * 65535);
      raw[o + 1 + x * 2] = v >> 8; raw[o + 2 + x * 2] = v & 255;
    }
  }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  for (const c of chunk('IDAT', z)) await sink.write(c);
  for (const c of chunk('IEND', new Uint8Array(0))) await sink.write(c);
  return sink.close();
}
