// A procedural landscape with an exact depth map, so the studio can be
// explored instantly, without a photo or the AI model download.

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeDemo(W = 1800, H = 1200) {
  const R = rng(7);
  const photo = document.createElement('canvas');
  photo.width = W; photo.height = H;
  const P = photo.getContext('2d');
  const dc = document.createElement('canvas');
  dc.width = W; dc.height = H;
  const D = dc.getContext('2d');
  const gray = (d) => { const v = Math.round(d * 255); return `rgb(${v},${v},${v})`; };
  const yh = H * 0.58; // horizon
  // on a flat ground plane disparity grows linearly below the horizon,
  // which is what a depth network reports for real photos
  const groundDepth = (y) => Math.max(0.02, 0.74 - 0.72 * (y - yh) / (H - yh));

  // sky
  let g = P.createLinearGradient(0, 0, 0, yh);
  g.addColorStop(0, '#8ea5bd'); g.addColorStop(0.7, '#d9cdb8'); g.addColorStop(1, '#efdcc0');
  P.fillStyle = g; P.fillRect(0, 0, W, yh + 2);
  D.fillStyle = gray(1); D.fillRect(0, 0, W, H);
  // sun haze
  const sg = P.createRadialGradient(W * 0.68, yh * 0.78, 10, W * 0.68, yh * 0.78, W * 0.35);
  sg.addColorStop(0, 'rgba(255,240,210,.85)'); sg.addColorStop(1, 'rgba(255,240,210,0)');
  P.fillStyle = sg; P.fillRect(0, 0, W, yh);

  // mountain ranges, far to near
  const ridge = (base, amp, rough, seed) => {
    const r = rng(seed), pts = [];
    let v = 0, dv = 0;
    for (let x = 0; x <= W; x += 6) { dv += (r() - 0.5) * rough; dv *= 0.9; v += dv; v *= 0.995; pts.push([x, base - amp * (0.5 + 0.5 * Math.sin(x / W * 5 + seed)) + v]); }
    return pts;
  };
  const ranges = [
    { base: yh - 40, amp: 160, rough: 6, col: '#a9b3c0', d: 0.95 },
    { base: yh - 10, amp: 110, rough: 7, col: '#8a96a6', d: 0.88 },
    { base: yh + 18, amp: 70, rough: 8, col: '#6c7766', d: 0.8 },
  ];
  ranges.forEach((m, k) => {
    const pts = ridge(m.base, m.amp, m.rough, k * 3 + 2);
    for (const [ctx, fill] of [[P, m.col], [D, gray(m.d)]]) {
      ctx.beginPath(); ctx.moveTo(0, H);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    }
    // atmospheric shading on the photo
    const mg = P.createLinearGradient(0, m.base - m.amp, 0, yh + 40);
    mg.addColorStop(0, 'rgba(255,255,255,0)'); mg.addColorStop(1, 'rgba(240,225,200,.35)');
    P.save(); P.beginPath(); P.moveTo(0, H); for (const [x, y] of pts) P.lineTo(x, y); P.lineTo(W, H); P.clip(); P.fillStyle = mg; P.fillRect(0, 0, W, H); P.restore();
  });

  // ground with perspective depth
  for (let y = Math.floor(yh); y < H; y++) {
    const t = (y - yh) / (H - yh);
    P.fillStyle = `rgb(${Math.round(70 + 60 * t)},${Math.round(84 + 40 * t)},${Math.round(52 + 10 * t)})`;
    P.fillRect(0, y, W, 1);
    D.fillStyle = gray(groundDepth(y + 0.5)); D.fillRect(0, y, W, 1);
  }
  // grass strokes
  for (let i = 0; i < 9000; i++) {
    const y = yh + Math.pow(R(), 0.6) * (H - yh), x = R() * W, s = (y - yh) / (H - yh);
    P.strokeStyle = `rgba(${30 + R() * 60},${50 + R() * 60},${20 + R() * 30},${0.25 + 0.4 * R()})`;
    P.lineWidth = 0.5 + s * 2;
    P.beginPath(); P.moveTo(x, y); P.lineTo(x + (R() - 0.5) * 6 * s, y - (3 + 14 * R()) * s); P.stroke();
  }

  // treeline in the middle distance
  const tlY = yh + 26, tlD = groundDepth(tlY);
  for (let x = -20; x < W * 0.55; x += 9 + R() * 10) {
    const h = 26 + R() * 34, w = 10 + R() * 12;
    for (const [ctx, fill] of [[P, `rgb(${36 + R() * 20},${52 + R() * 20},${38 + R() * 10})`], [D, gray(tlD)]]) {
      ctx.fillStyle = fill; ctx.beginPath(); ctx.ellipse(x, tlY - h / 2, w, h / 2, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  // fence posts receding toward the horizon
  for (let i = 0; i < 22; i++) {
    const t = i / 21;
    const by = H * 0.99 - (H * 0.99 - (yh + 12)) * (1 - Math.pow(1 - t, 0.35));
    const s = (by - yh) / (H - yh);
    const x = W * 0.06 + (W * 0.47 - W * 0.06) * (1 - s);
    const ph = 260 * s, pw = Math.max(1.5, 22 * s), d = groundDepth(by);
    for (const [ctx, fill] of [[P, '#3b2f25'], [D, gray(d)]]) { ctx.fillStyle = fill; ctx.fillRect(x - pw / 2, by - ph, pw, ph); }
    P.fillStyle = 'rgba(255,230,190,.25)'; P.fillRect(x - pw / 2, by - ph, pw * 0.3, ph);
  }

  // lone tree
  const tx = W * 0.72, ty = H * 0.74, td = groundDepth(ty);
  for (const [ctx, trunk, crown] of [[P, '#3a2c20', null], [D, gray(td), gray(td)]]) {
    ctx.fillStyle = trunk; ctx.fillRect(tx - 9, ty - 170, 18, 170);
    const r2 = rng(11);
    for (let k = 0; k < 26; k++) {
      const a = r2() * Math.PI * 2, rr = r2() * 90;
      ctx.fillStyle = crown || `rgb(${40 + r2() * 30},${70 + r2() * 40},${40 + r2() * 20})`;
      ctx.beginPath(); ctx.arc(tx + Math.cos(a) * rr * 1.2, ty - 230 + Math.sin(a) * rr * 0.7, 34 + r2() * 30, 0, Math.PI * 2); ctx.fill();
    }
  }

  // a figure in the foreground
  const fx = W * 0.3, fy = H * 0.97, fd = groundDepth(fy - 4);
  for (const [ctx, fill, coat] of [[P, '#d8b59a', '#7b2f2a'], [D, gray(fd), gray(fd)]]) {
    ctx.fillStyle = coat; ctx.beginPath();
    ctx.moveTo(fx - 70, fy); ctx.lineTo(fx - 58, fy - 300); ctx.quadraticCurveTo(fx, fy - 360, fx + 58, fy - 300); ctx.lineTo(fx + 70, fy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(fx, fy - 395, 46, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = coat === '#7b2f2a' ? '#2b211c' : coat; ctx.beginPath(); ctx.arc(fx, fy - 410, 48, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
  }

  // film-like texture on the photo
  const id = P.getImageData(0, 0, W, H), px = id.data;
  for (let i = 0; i < px.length; i += 4) { const n = (R() - 0.5) * 14; px[i] += n; px[i + 1] += n; px[i + 2] += n; }
  P.putImageData(id, 0, 0);

  const dd = D.getImageData(0, 0, W, H).data;
  const depth = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) depth[i] = dd[i * 4] / 255;
  return { photo, depth: { w: W, h: H, data: depth } };
}
