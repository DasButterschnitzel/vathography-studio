// Vathography Studio: application shell. Wires the renderer, depth pipeline,
// controls, depth ruler, library and exports together.
import { Renderer, MAX_HL } from './renderer.js';
import { computeLayout, ASPECTS, clamp } from './layout.js';
import { estimateDepth, MODELS, DETAIL, resizeFloat } from './depth.js';
import { defaultSettings, normalize, newHighlighter, LOOKS, applyLook, newId } from './state.js';
import { store } from './store.js';
import { exportImage, recordVideo, download, PRINT_SIZES, SOCIAL, animState, videoMime } from './export.js';
import { readPNGChannel, depthToPNG } from './codecs.js';
import { makeDemo } from './demo.js';
import { histogram, subjectPeaks } from './analysis.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt2 = (v) => (+v).toFixed(2), fmt3 = (v) => (+v).toFixed(3), fmt0 = (v) => String(Math.round(v)), fmtDeg = (v) => Math.round(v) + '°';
const DEFAULTS = defaultSettings(), HL_DEF = newHighlighter();
// preview resolution: phones report 3× and more, which costs a lot of fill rate for no visible gain
const dpr = () => Math.min(devicePixelRatio || 1, 2);

// ---- state ------------------------------------------------------------------
const app = {
  s: defaultSettings(),
  project: null,         // { id, name, created, photoName, proc }
  photo: null,           // { bitmap, blob, w, h, ow, oh }
  raw: null,             // { w, h, data } depth before edge refinement (0 near … 1 far)
  depth: null,           // { w, h, data } refined depth used for rendering
  sel: null,
  view: { mode: 0, tool: 'hand', scale: 1, ox: 0, oy: 0, split: 0.5, fitted: true },
  hist: null, peaks: [],
  undo: [], redo: [], committed: null,
  playing: false, playT0: 0,
  assetsDirty: { photo: false, raw: false },
};
const proc0 = () => ({ model: 'small', detail: 'standard', refineRes: 4096, snap: 0.6, radius: 1, refine: true, source: 'ai' });
let renderer;
try { renderer = new Renderer($('gl')); } catch (e) {
  document.body.innerHTML = `<div style="padding:40px;font:15px system-ui;color:#eee;background:#111;height:100vh">Vathography Studio needs WebGL2 (any current Chrome, Edge, Firefox or Safari).<br><br><small>${e.message}</small></div>`;
  throw e;
}

// ---- small UI helpers -------------------------------------------------------
let toastTimer;
function toast(msg, err = false, ms = 3800) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, ms);
}
let busyAbort = null;
function busy(stage, progress = null, cancel = null) {
  $('busy').hidden = false;
  if (stage) $('busyStage').textContent = stage;
  const bar = $('busyBar').parentElement;
  bar.classList.toggle('indet', progress == null);
  if (progress != null) $('busyBar').style.width = (progress * 100).toFixed(1) + '%';
  busyAbort = cancel;
  $('busyCancel').hidden = !cancel;
}
function idle() { $('busy').hidden = true; busyAbort = null; }
$('busyCancel').onclick = () => busyAbort?.abort();

const remap = (raw) => {
  const dp = app.s.depth;
  let d = clamp((raw - dp.near) / Math.max(dp.far - dp.near, 1e-5), 0, 1);
  d = Math.pow(d, dp.gamma);
  return dp.invert ? 1 - d : d;
};
const layout = () => computeLayout(app.s.frame, app.photo?.w || 3, app.photo?.h || 2, app.s.signature);
const selHL = () => app.s.highlighters.find((h) => h.id === app.sel) || null;

// ---- rendering ----------------------------------------------------------------
let rafPending = false;
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(draw);
}
function draw() {
  rafPending = false;
  if (!app.photo || app.recording) return;
  const L = layout(), v = app.view;
  const extra = app.playing ? animState(app.s, app.s.anim, (performance.now() - app.playT0) / 1000) : {};
  renderer.render(app.s, L, {
    origin: [-v.ox / v.scale, -v.oy / v.scale], px: 1 / (v.scale * dpr()),
    mode: v.mode === 3 ? 0 : v.mode, split: v.mode === 3 ? v.split * L.artW : -1, ...extra,
  });
  if (app.playing) requestRender();
  updateZoomLabel(L);
}

function resizeCanvas() {
  const vp = $('viewport'), c = $('gl'), r = dpr();
  const w = Math.max(1, Math.round(vp.clientWidth * r)), h = Math.max(1, Math.round(vp.clientHeight * r));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  if (app.view.fitted) fit();
  requestRender();
  drawRuler();
}
new ResizeObserver(resizeCanvas).observe($('viewport'));
new ResizeObserver(() => drawRuler()).observe($('rulerBody'));

function fit() {
  const vp = $('viewport'), L = layout(), pad = 28;
  const vw = vp.clientWidth, vh = vp.clientHeight;
  const sc = Math.max(1e-3, Math.min((vh - pad * 2), (vw - pad * 2) / L.artW));
  Object.assign(app.view, { scale: sc, ox: (vw - L.artW * sc) / 2, oy: (vh - sc) / 2, fitted: true });
  requestRender();
}
function onePxScale(L) {
  return (L.srcRect.h * renderer.photoSize[1] / L.imgRect.h) / dpr();
}
function zoomTo(scale, cx, cy) {
  const v = app.view;
  scale = clamp(scale, 20, 400000);
  v.ox = cx - (cx - v.ox) * scale / v.scale;
  v.oy = cy - (cy - v.oy) * scale / v.scale;
  v.scale = scale; v.fitted = false;
  requestRender();
}
function updateZoomLabel(L) {
  if (!app.photo) return;
  $('zoomLabel').textContent = Math.round(app.view.scale / onePxScale(L) * 100) + '%';
}
$('zoomFit').onclick = fit;
$('zoom100').onclick = () => { const vp = $('viewport'); zoomTo(onePxScale(layout()), vp.clientWidth / 2, vp.clientHeight / 2); };

// ---- viewport interaction ---------------------------------------------------
const vp = $('viewport');
const pointers = new Map();
let drag = null;
function artAt(e) {
  const r = vp.getBoundingClientRect(), v = app.view;
  return { x: (e.clientX - r.left - v.ox) / v.scale, y: (e.clientY - r.top - v.oy) / v.scale, cx: e.clientX - r.left, cy: e.clientY - r.top };
}
function depthAtArt(p) {
  if (!app.depth) return null;
  const L = layout(), ir = L.imgRect, sr = L.srcRect;
  const rx = (p.x - ir.x) / ir.w, ry = (p.y - ir.y) / ir.h;
  if (rx < 0 || ry < 0 || rx > 1 || ry > 1) return null;
  const u = sr.x + rx * sr.w, v = sr.y + ry * sr.h, D = app.depth;
  const x = clamp(Math.floor(u * D.w), 0, D.w - 1), y = clamp(Math.floor(v * D.h), 0, D.h - 1);
  return remap(D.data[y * D.w + x]);
}
vp.addEventListener('wheel', (e) => {
  if (!app.photo) return;
  e.preventDefault();
  const p = artAt(e);
  const k = e.ctrlKey ? 0.01 : 0.0015;
  zoomTo(app.view.scale * Math.exp(-e.deltaY * k), p.cx, p.cy);
}, { passive: false });
vp.addEventListener('dblclick', () => { if (app.photo && app.view.tool === 'hand' && lastPointer === 'mouse') fit(); });
let lastPointer = 'mouse', lastTap = { t: 0, x: 0, y: 0 }, readoutT;
function showReadout(d) {
  const ro = $('readout');
  clearTimeout(readoutT);
  if (d == null) { ro.hidden = true; showHoverLine(null); return; }
  ro.hidden = false; ro.textContent = `distance ${d.toFixed(3)}  ·  ${d < 0.33 ? 'near' : d < 0.66 ? 'middle' : 'far'}`; showHoverLine(d);
}
vp.addEventListener('pointerdown', (e) => {
  if (!app.photo) return;
  lastPointer = e.pointerType;
  vp.focus({ preventScroll: true });
  vp.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, artAt(e));
  if (pointers.size === 2) {
    clearTimeout(drag?.timer);
    const [a, b] = [...pointers.values()], dist = Math.max(10, Math.hypot(a.cx - b.cx, a.cy - b.cy));
    // pinch zooms the view; with the crop tool it zooms the crop
    drag = app.view.tool === 'frame' ? { kind: 'cropzoom', dist, zoom: app.s.frame.zoom } : { kind: 'pinch', dist, scale: app.view.scale };
    return;
  }
  if (pointers.size > 2) return;
  const p = artAt(e), v = app.view, touch = e.pointerType !== 'mouse';
  if (v.mode === 3 && Math.abs(p.x - v.split * layout().artW) * v.scale < (touch ? 24 : 10)) { drag = { kind: 'split' }; return; }
  const tool = e.button === 1 || e.button === 2 ? 'hand' : v.tool;
  if (tool === 'pick' && touch) {
    // touch: a tap moves the selected band, a drag scrubs through distances, a long press adds a band
    const d = depthAtArt(p);
    showReadout(d);
    drag = { kind: 'pickwait', x: e.clientX, y: e.clientY, d, timer: setTimeout(() => {
      if (drag?.kind !== 'pickwait' || drag.d == null) return;
      pickDepth(drag.d, true); commit(); drag = { kind: 'done' };
      navigator.vibrate?.(12);
      toast(`Added ${selHL().name} at distance ${selHL().center.toFixed(2)}`);
    }, 520) };
  } else if (tool === 'pick') {
    const d = depthAtArt(p);
    if (d != null) pickDepth(d, e.shiftKey || e.altKey);
    drag = { kind: 'pick' };
  } else if (tool === 'frame') {
    drag = { kind: 'frame', p, cx: app.s.frame.cx, cy: app.s.frame.cy };
  } else {
    drag = { kind: 'pan', x: e.clientX, y: e.clientY, ox: v.ox, oy: v.oy, t0: e.timeStamp };
  }
  vp.classList.add('dragging');
});
vp.addEventListener('pointermove', (e) => {
  if (!app.photo) return;
  const p = artAt(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  const d = depthAtArt(p), mouse = e.pointerType === 'mouse';
  if (mouse || drag?.kind === 'pick' || drag?.kind === 'pickwait') showReadout(d);
  if (!drag) return;
  const v = app.view;
  if (drag.kind === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    zoomTo(drag.scale * Math.hypot(a.cx - b.cx, a.cy - b.cy) / drag.dist, (a.cx + b.cx) / 2, (a.cy + b.cy) / 2);
  } else if (drag.kind === 'cropzoom' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    app.s.frame.zoom = +clamp(drag.zoom * Math.hypot(a.cx - b.cx, a.cy - b.cy) / drag.dist, 1, 4).toFixed(4);
    onChange('frame');
  } else if (drag.kind === 'pan') {
    v.ox = drag.ox + e.clientX - drag.x; v.oy = drag.oy + e.clientY - drag.y; v.fitted = false; requestRender();
  } else if (drag.kind === 'split') {
    v.split = clamp(p.x / layout().artW, 0, 1); requestRender();
  } else if (drag.kind === 'pickwait') {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) { clearTimeout(drag.timer); drag = { kind: 'pick' }; if (!selHL() && d != null) pickDepth(d, true); }
  } else if (drag.kind === 'pick' && d != null && e.buttons) {
    const h = selHL(); if (h) { h.center = d; onChange('hl'); }
  } else if (drag.kind === 'frame') {
    const L = layout(), f = app.s.frame;
    f.cx = clamp(drag.cx - (p.x - drag.p.x) / L.imgRect.w * L.srcRect.w, 0, 1);
    f.cy = clamp(drag.cy - (p.y - drag.p.y) / L.imgRect.h * L.srcRect.h, 0, 1);
    const L2 = layout(); f.cx = L2.srcRect.x + L2.srcRect.w / 2; f.cy = L2.srcRect.y + L2.srcRect.h / 2;
    onChange('frame');
  }
});
const endDrag = (e) => {
  pointers.delete(e.pointerId);
  const touch = e.pointerType !== 'mouse';
  if (drag?.kind === 'pickwait') {
    clearTimeout(drag.timer);
    if (drag.d != null && e.type === 'pointerup') { pickDepth(drag.d, false); commit(); renderPanel(); }
  } else if (drag && (drag.kind === 'pick' || drag.kind === 'frame' || drag.kind === 'cropzoom')) { commit(); renderPanel(); }
  else if (drag?.kind === 'pan' && touch && e.type === 'pointerup' && e.timeStamp - drag.t0 < 300 && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 10) {
    // double tap: zoom in where tapped, or back to fit (timed by the touch events, not by when they are handled)
    const now = e.timeStamp, r = vp.getBoundingClientRect();
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      if (app.view.fitted) zoomTo(app.view.scale * 2.5, e.clientX - r.left, e.clientY - r.top); else fit();
      lastTap.t = 0;
    } else lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
  if (touch) readoutT = setTimeout(() => showReadout(null), 900);
  if (pointers.size < 2) drag = null;
  vp.classList.remove('dragging');
};
vp.addEventListener('pointerup', endDrag);
vp.addEventListener('pointercancel', endDrag);
vp.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') showReadout(null); });
vp.addEventListener('contextmenu', (e) => e.preventDefault());

function pickDepth(d, add) {
  let h = selHL();
  if (add || !h) {
    if (app.s.highlighters.length >= MAX_HL) { toast(`Up to ${MAX_HL} highlighters`); return; }
    h = newHighlighter({ ...(h ? { ...h, id: undefined } : {}), id: newId(), name: `Plane ${app.s.highlighters.length + 1}`, center: d });
    app.s.highlighters.push(h);
    app.sel = h.id;
    renderPanel();
  } else h.center = d;
  onChange('hl');
}

function setView(m) {
  app.view.mode = m;
  for (const b of $('viewSeg').children) b.classList.toggle('on', +b.dataset.view === m);
  requestRender();
}
const coarse = matchMedia('(pointer: coarse)');
function setTool(t) {
  if (coarse.matches && t !== app.view.tool && app.photo) {
    if (t === 'pick') toast('Tap the photo to move the selected band to that distance. Long-press adds a new band.');
    if (t === 'frame') toast('Drag to move the crop, pinch to zoom it.');
  }
  app.view.tool = t;
  for (const b of $('toolSeg').children) b.classList.toggle('on', b.dataset.tool === t);
  vp.classList.toggle('pick', t === 'pick');
  vp.classList.toggle('frame', t === 'frame');
}
$('viewSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) setView(+b.dataset.view); };
$('toolSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); };
$('btnPlay').onclick = togglePlay;
function togglePlay() {
  if (!app.photo) return;
  app.playing = !app.playing;
  app.playT0 = performance.now();
  $('btnPlay').innerHTML = app.playing ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg><span>Stop</span>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7Z" fill="currentColor"/></svg><span>Animate</span>';
  $('btnPlay').classList.toggle('on', app.playing);
  requestRender();
}

// ---- depth ruler ----------------------------------------------------------------
function drawRuler() {
  const c = $('hist'), body = $('rulerBody'), r = dpr();
  const w = Math.max(1, Math.round(body.clientWidth * r)), h = Math.max(1, Math.round(body.clientHeight * r));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d');
  const b = app.s.base;
  // atmosphere gradient as the ruler background
  const g = ctx.createLinearGradient(0, 0, w, 0);
  const hex = (x) => x;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, gg = Math.pow(t, b.curve);
    const col = gg < b.midPos ? mixHex(b.near, b.mid, gg / Math.max(b.midPos, 1e-4)) : mixHex(b.mid, b.far, (gg - b.midPos) / Math.max(1 - b.midPos, 1e-4));
    g.addColorStop(t, hex(col));
  }
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, w, h);
  if (app.hist) {
    const H = app.hist, n = H.length;
    let max = 0;
    for (const v of H) max = Math.max(max, v);
    ctx.fillStyle = 'rgba(236,235,231,.55)';
    for (let i = 0; i < n; i++) {
      const v = Math.log1p(H[i]) / Math.log1p(max);
      const x0 = Math.floor(i / n * w), x1 = Math.ceil((i + 1) / n * w);
      ctx.fillRect(x0, h - v * h * 0.92, x1 - x0, v * h * 0.92);
    }
    ctx.fillStyle = 'rgba(226,195,143,.9)';
    for (const p of app.peaks) ctx.fillRect(Math.round(p * w) - 1, h - 5 * r, 2 * r, 5 * r);
  }
  renderBands();
}
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
function renderBands() {
  const box = $('bands');
  box.textContent = '';
  for (const h of app.s.highlighters) {
    const b = el('div', 'band' + (h.id === app.sel ? ' sel' : '') + (h.on ? '' : ' off'));
    const w = h.style === 'line' ? 0 : h.width;
    b.style.left = `calc(${(h.center - w / 2) * 100}% - ${w ? 0 : 3}px)`;
    b.style.width = w ? `${w * 100}%` : '6px';
    b.style.color = h.color;
    b.style.borderColor = h.color;
    b.style.background = hexA(h.color, 0.22);
    const body = el('div', 'body');
    b.append(el('div', 'center'), body, el('div', 'lbl', h.name));
    b.dataset.id = h.id;
    box.append(b);
  }
}
function hexA(h, a) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
function showHoverLine(d) {
  const l = $('hoverLine');
  if (d == null) { l.hidden = true; return; }
  l.hidden = false; l.style.left = (d * 100) + '%';
}
{
  const rb = $('rulerBody'), rp = new Map();
  let rd = null, lastTapT = 0, rulerPointer = 'mouse', downOnBand = false;
  const xToD = (e) => { const r = rb.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  // touch: grab the nearest band, since thin bands are hard to hit with a finger
  const bandAt = (e) => {
    const t = e.target.closest('.band');
    if (t) return app.s.highlighters.find((x) => x.id === t.dataset.id);
    if (e.pointerType === 'mouse') return null;
    const r = rb.getBoundingClientRect();
    let best = null, bd = 28;
    for (const h of app.s.highlighters) { const dx = Math.abs(r.left + h.center * r.width - e.clientX); if (dx < bd) { bd = dx; best = h; } }
    return best;
  };
  rb.addEventListener('pointerdown', (e) => {
    if (!app.photo) return;
    rulerPointer = e.pointerType;
    rb.setPointerCapture(e.pointerId);
    rp.set(e.pointerId, e.clientX);
    if (rp.size === 2 && rd?.h) {
      // second finger: pinch sets the band's width (a line's thickness)
      const [a, b] = [...rp.values()];
      rd = { h: rd.h, kind: 'pinch', dist: Math.max(12, Math.abs(a - b)), w0: rd.h.width, t0: rd.h.thickness };
      return;
    }
    if (rp.size > 1) return;
    const h = bandAt(e);
    downOnBand = !!h;
    if (!h) { rd = { kind: 'empty' }; return; }
    if (app.sel !== h.id) { app.sel = h.id; renderPanel(); renderBands(); }
    const edge = e.pointerType === 'mouse' && e.target.closest('.band') && !e.target.classList.contains('body') && h.style !== 'line';
    rd = { h, kind: edge ? 'resize' : 'move', d0: xToD(e), c0: h.center };
    showHoverLine(h.center);
    e.preventDefault();
  });
  rb.addEventListener('pointermove', (e) => {
    if (rp.has(e.pointerId)) rp.set(e.pointerId, e.clientX);
    const d = xToD(e);
    if (e.pointerType === 'mouse') showHoverLine(d);
    if (!rd || rd.kind === 'empty') return;
    if (rd.kind === 'pinch') {
      if (rp.size < 2) return;
      const [a, b] = [...rp.values()], k = Math.abs(a - b) / rd.dist;
      if (rd.h.style === 'line') rd.h.thickness = +clamp(rd.t0 * k, 0.2, 12).toFixed(3);
      else rd.h.width = +clamp(rd.w0 * k, 0.002, 1).toFixed(4);
    } else if (rd.kind === 'move') { rd.h.center = clamp(rd.c0 + d - rd.d0, 0, 1); showHoverLine(rd.h.center); }
    else rd.h.width = clamp(Math.abs(d - rd.h.center) * 2, 0.002, 1);
    onChange('hl');
    syncEditor();
  });
  const up = (e) => {
    rp.delete(e.pointerId);
    if (!rd) return;
    if (rd.kind === 'empty') {
      // double tap on free space adds a band there (mouse: dblclick)
      if (e.pointerType !== 'mouse' && e.type === 'pointerup') {
        const now = e.timeStamp;
        if (now - lastTapT < 350) { pickDepth(xToD(e), true); commit(); lastTapT = 0; } else lastTapT = now;
      }
      rd = null;
      return;
    }
    if (rp.size) return;
    rd = null; commit(); renderPanel();
    if (e.pointerType !== 'mouse') showHoverLine(null);
  };
  rb.addEventListener('pointerup', up);
  rb.addEventListener('pointercancel', up);
  rb.addEventListener('pointerleave', (e) => { if (!rd && e.pointerType === 'mouse') showHoverLine(null); });
  rb.addEventListener('dblclick', (e) => { if (!app.photo || rulerPointer !== 'mouse' || downOnBand) return; pickDepth(xToD(e), true); commit(); });
  $('rulerTitle').textContent = coarse.matches ? 'Drag a band · pinch to change its width · double-tap to add' : 'Depth: drag the bands, double-click to add one';
}

// ---- change tracking, undo, autosave ------------------------------------------
function onChange(kind) {
  if (kind === 'hl') { renderBands(); updateHlMeta(); }
  if (kind === 'depth') recomputeHist();
  if (kind === 'base') drawRuler();
  if (kind === 'frame' || kind === 'sig') { updateSignature(); if (app.view.fitted) fit(); }
  requestRender();
  markDirty();
}
function snapshot() { return JSON.stringify(app.s); }
function commit() {
  const now = snapshot();
  if (now === app.committed) return;
  if (app.committed) app.undo.push(app.committed);
  if (app.undo.length > 150) app.undo.shift();
  app.redo = [];
  app.committed = now;
  updateUndoButtons();
  scheduleSave();
}
function restore(json) {
  const fr = app.s.frame.aspect;
  app.s = normalize(JSON.parse(json));
  app.committed = json;
  if (!app.s.highlighters.find((h) => h.id === app.sel)) app.sel = app.s.highlighters[0]?.id || null;
  recomputeHist(); updateSignature(); renderPanel();
  if (fr !== app.s.frame.aspect || app.view.fitted) fit();
  requestRender(); updateUndoButtons(); scheduleSave();
}
function undo() { if (!app.undo.length) return; app.redo.push(snapshot()); restore(app.undo.pop()); }
function redo() { if (!app.redo.length) return; app.undo.push(snapshot()); restore(app.redo.pop()); }
function updateUndoButtons() { $('btnUndo').disabled = !app.undo.length; $('btnRedo').disabled = !app.redo.length; }
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;

let saveTimer = null;
function markDirty() { $('saveState').textContent = app.project ? 'Unsaved changes…' : ''; }
function scheduleSave() {
  if (!app.project) return;
  markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 1200);
}
async function saveProject() {
  if (!app.project || !app.photo || !app.raw) return;
  clearTimeout(saveTimer);
  try {
    const thumb = await canvasBlob(renderer.renderToCanvas(app.s, layout(), 480), 'image/jpeg', 0.85);
    const p = app.project;
    const meta = { id: p.id, name: p.name, created: p.created, updated: Date.now(), photoName: p.photoName, proc: p.proc, settings: app.s, thumb, w: app.photo.ow, h: app.photo.oh };
    const assets = {};
    if (app.assetsDirty.photo) assets.photo = app.photo.blob;
    if (app.assetsDirty.raw) assets.raw = await depthToPNG(app.raw.data, app.raw.w, app.raw.h);
    await store.saveProject(meta, assets);
    app.assetsDirty = { photo: false, raw: false };
    $('saveState').textContent = 'Saved';
  } catch (e) {
    console.error(e);
    $('saveState').textContent = 'Not saved';
    toast('Could not save to the browser library: ' + e.message, true);
  }
}
const canvasBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));

// ---- signature ------------------------------------------------------------------
let sigKey = '';
async function updateSignature(targetPx) {
  const sg = app.s.signature, L = layout();
  if (!sg.on || !sg.text || !L.sigRect) { renderer.setSignature(null); sigKey = ''; requestRender(); return; }
  const px = Math.round(clamp(targetPx || L.sigRect.h * app.view.scale * dpr() * 1.5, 48, 1200));
  const key = [sg.text, sg.font, sg.italic, sg.spacing, Math.round(Math.log2(px) * 4)].join('|');
  if (key === sigKey && !targetPx) { requestRender(); return; }
  sigKey = targetPx ? '' : key;
  const font = `${sg.italic ? 'italic ' : ''}400 ${px}px "${sg.font}"`;
  try { await document.fonts.load(font, sg.text); } catch { /* system fallback */ }
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${sg.spacing * px}px`;
  const m = ctx.measureText(sg.text);
  c.width = Math.max(1, Math.ceil(m.width + px * 0.3)); c.height = Math.ceil(px * 1.3);
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${sg.spacing * px}px`;
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.fillText(sg.text, px * 0.15, c.height / 2);
  renderer.setSignature(c);
  requestRender();
}

// ---- depth pipeline ---------------------------------------------------------------
function refineInputs(res) {
  const ph = app.photo.bitmap;
  const long = Math.min(res, renderer.maxTex, Math.max(ph.width, ph.height));
  const sc = long / Math.max(ph.width, ph.height);
  const W = Math.max(1, Math.round(ph.width * sc)), H = Math.max(1, Math.round(ph.height * sc));
  const lowLong = Math.min(long, res >= 4096 ? 1400 : 1024);
  const ls = lowLong / Math.max(ph.width, ph.height);
  const w = Math.max(1, Math.round(ph.width * ls)), h = Math.max(1, Math.round(ph.height * ls));
  const grab = (cw, ch) => {
    const c = new OffscreenCanvas(cw, ch), x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(ph, 0, 0, cw, ch);
    return x.getImageData(0, 0, cw, ch).data;
  };
  return { full: { w: W, h: H, data: grab(W, H) }, low: { w, h, data: grab(w, h) } };
}
let refineGen = 0;
async function refineDepth() {
  const p = app.project.proc, gen = ++refineGen;
  if (!p.refine) {
    const long = Math.min(p.refineRes, renderer.maxTex, Math.max(app.photo.w, app.photo.h));
    const sc = long / Math.max(app.photo.w, app.photo.h);
    const W = Math.round(app.photo.w * sc), H = Math.round(app.photo.h * sc);
    setDepth({ w: W, h: H, data: resizeFloat(app.raw.data, app.raw.w, app.raw.h, W, H) });
    return;
  }
  const inp = refineInputs(p.refineRes);
  const radius = Math.max(1, Math.round(p.radius * Math.max(inp.low.w, inp.low.h) / 110));
  const eps = Math.pow(10, -1 - 2.5 * p.snap);
  const out = await new Promise((res, rej) => {
    const wk = new Worker(new URL('./refine.worker.js', import.meta.url));
    wk.onmessage = (e) => {
      if (e.data.error) { wk.terminate(); rej(new Error(e.data.error)); }
      else if (e.data.done) { wk.terminate(); res(e.data); }
      else if (e.data.stage || e.data.progress) busy(e.data.stage, e.data.progress);
    };
    wk.onerror = (e) => { wk.terminate(); rej(new Error(e.message || 'refine worker failed')); };
    wk.postMessage({ full: inp.full, low: inp.low, depth: app.raw, radius, eps }, [inp.full.data.buffer, inp.low.data.buffer]);
  });
  if (gen !== refineGen) return;
  setDepth(out);
}
function setDepth(d) {
  app.depth = d;
  renderer.setDepth(d.data, d.w, d.h);
  recomputeHist();
  requestRender();
}
function recomputeHist() {
  if (!app.depth) { app.hist = null; app.peaks = []; drawRuler(); return; }
  const D = app.depth;
  app.hist = histogram(D.data, D.w, D.h, remap, 256);
  app.peaks = subjectPeaks(D.data, D.w, D.h, remap, 3);
  drawRuler();
}

async function runAI() {
  const p = app.project.proc;
  const ac = new AbortController();
  busy('Preparing…', null);
  const small = await createImageBitmap(app.photo.bitmap, scaleOpts(app.photo.bitmap, 1400));
  try {
    const r = await estimateDepth(small, { model: p.model, detail: p.detail }, (e) => busy(e.stage, e.progress ?? null));
    if (ac.signal.aborted) return false;
    app.raw = { w: r.w, h: r.h, data: r.data };
    p.source = 'ai';
    app.assetsDirty.raw = true;
    return true;
  } catch (e) {
    console.error(e);
    toast('AI depth is unavailable (offline or unsupported browser). Using a simple top-to-bottom gradient. Retry from Depth ▸ Estimate, or import a depth map. ' + (e.message || ''), true, 9000);
    app.raw = fallbackDepth();
    p.source = 'fallback';
    app.assetsDirty.raw = true;
    return false;
  } finally { small.close?.(); }
}
function fallbackDepth() {
  const w = 64, h = 64, data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = 1 - y / (h - 1);
  return { w, h, data };
}
function scaleOpts(bm, long) {
  const s = Math.min(1, long / Math.max(bm.width, bm.height));
  return { resizeWidth: Math.max(1, Math.round(bm.width * s)), resizeHeight: Math.max(1, Math.round(bm.height * s)), resizeQuality: 'high' };
}

// ---- projects ------------------------------------------------------------------------
async function setPhoto(blob, name) {
  let bm = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const ow = bm.width, oh = bm.height;
  const lim = Math.min(renderer.maxTex, 16384);
  if (Math.max(ow, oh) > lim) { const b2 = await createImageBitmap(bm, scaleOpts(bm, lim)); bm.close(); bm = b2; }
  app.photo?.bitmap?.close?.();
  app.photo = { bitmap: bm, blob, w: bm.width, h: bm.height, ow, oh, name };
  renderer.setPhoto(bm);
}
function showStudio() {
  const first = document.documentElement.classList.contains('no-photo');
  document.documentElement.classList.remove('no-photo');
  if (first) { ui.tab = 'looks'; setSheet(true); }
  $('empty').hidden = true;
  $('projName').disabled = false;
  $('projName').value = app.project.name;
  for (const id of ['btnExport', 'btnSnapshot']) $(id).disabled = false;
}

async function openPhotoFile(file) {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|avif|gif|bmp|tiff?)$/i.test(file.name)) { toast('That is not an image file', true); return; }
  try {
    busy('Opening photo…');
    if (app.project) await saveProject();
    await setPhoto(file, file.name);
    app.project = { id: newId(), name: file.name.replace(/\.[^.]+$/, ''), created: Date.now(), photoName: file.name, proc: { ...proc0(), ...(app.project?.proc ? { model: app.project.proc.model, detail: app.project.proc.detail, refineRes: app.project.proc.refineRes } : {}) } };
    app.assetsDirty = { photo: true, raw: true };
    showStudio();
    app.s = normalize({ ...defaultSettings(), signature: app.s.signature, anim: app.s.anim });
    await runAI();
    await refineDepth();
    app.s = applyLook(app.s, lastLook(), app.peaks);
    app.look = lastLook().name;
    afterLoad();
    idle();
    saveProject();
    loadLookThumbs();
  } catch (e) {
    console.error(e); idle();
    toast('Could not open this photo: ' + e.message, true, 7000);
  }
}
function lastLook() {
  let name = 'Single Plane';
  try { name = localStorage.getItem('vath.lastLook') || name; } catch { /* private mode */ }
  return LOOKS.find((l) => l.name === name) || LOOKS[0];
}
function afterLoad() {
  app.sel = app.s.highlighters[0]?.id || null;
  app.undo = []; app.redo = []; app.committed = snapshot();
  updateUndoButtons();
  recomputeHist();
  updateSignature();
  renderPanel();
  fit();
  resizeCanvas();
}

async function openDemo() {
  busy('Building the demo scene…');
  await new Promise((r) => setTimeout(r, 30));
  if (app.project) await saveProject();
  const { photo, depth } = makeDemo();
  const blob = await canvasBlob(photo, 'image/jpeg', 0.92);
  await setPhoto(blob, 'demo.jpg');
  app.raw = depth;
  app.project = { id: newId(), name: 'Demo landscape', created: Date.now(), photoName: 'demo.jpg', proc: { ...proc0(), source: 'import', refine: false } };
  app.assetsDirty = { photo: true, raw: true };
  showStudio();
  app.s = normalize({ ...defaultSettings(), signature: app.s.signature });
  await refineDepth();
  app.s = applyLook(app.s, LOOKS.find((l) => l.name === 'Three Distances'), app.peaks);
  app.look = 'Three Distances';
  afterLoad();
  idle();
  saveProject();
  loadLookThumbs();
  toast(mobile ? 'Demo loaded. Pick a look, or drag the bands in the depth ruler.' : 'Demo loaded. Drag the bands in the depth ruler, or pick a look on the right.');
}

async function openProject(id) {
  try {
    busy('Opening artwork…');
    if (app.project && app.project.id !== id) await saveProject();
    const p = await store.getProject(id);
    if (!p) throw new Error('not found');
    await setPhoto(p.photo, p.photoName);
    const raw = await readPNGChannel(await p.raw.arrayBuffer());
    app.raw = { w: raw.w, h: raw.h, data: raw.data };
    app.project = { id: p.id, name: p.name, created: p.created, photoName: p.photoName, proc: { ...proc0(), ...p.proc } };
    app.assetsDirty = { photo: false, raw: false };
    showStudio();
    app.s = normalize(p.settings);
    app.look = null;
    await refineDepth();
    afterLoad();
    $('saveState').textContent = 'Saved';
    idle();
    loadLookThumbs();
  } catch (e) {
    console.error(e); idle();
    toast('Could not open this artwork: ' + e.message, true);
  }
}

async function importDepthMap(file) {
  if (!app.photo) { toast('Open the photo first, then import its depth map'); return; }
  try {
    busy('Reading depth map…');
    const buf = await file.arrayBuffer();
    let d = await readPNGChannel(buf);
    if (!d) {
      const bm = await createImageBitmap(new Blob([buf]));
      const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d');
      x.drawImage(bm, 0, 0);
      const px = x.getImageData(0, 0, bm.width, bm.height).data;
      const data = new Float32Array(bm.width * bm.height);
      for (let i = 0; i < data.length; i++) data[i] = px[i * 4] / 255;
      d = { w: bm.width, h: bm.height, data, bitDepth: 8 };
    }
    // most depth maps (Marigold, Depth Anything, Photoshop) are white = near: convert to 0 = near
    if (app.project.proc.importWhiteNear !== false) for (let i = 0; i < d.data.length; i++) d.data[i] = 1 - d.data[i];
    const ar = d.w / d.h, pr = app.photo.w / app.photo.h;
    if (Math.abs(ar - pr) / pr > 0.02) toast(`Note: depth map aspect (${d.w}×${d.h}) differs from the photo; it will be stretched`, true, 7000);
    app.raw = { w: d.w, h: d.h, data: d.data };
    app.project.proc.source = 'import';
    // a full-resolution depth map (e.g. Marigold) already has exact edges
    app.project.proc.refine = Math.max(d.w, d.h) < 0.6 * Math.max(app.photo.ow, app.photo.oh);
    app.assetsDirty.raw = true;
    await refineDepth();
    idle();
    renderPanel();
    scheduleSave();
    toast(`Imported ${d.bitDepth}-bit depth map (${d.w}×${d.h}). If near and far look swapped, use Depth ▸ Invert.`);
  } catch (e) { console.error(e); idle(); toast('Could not read the depth map: ' + e.message, true); }
}

async function saveVersion() {
  if (!app.project) return;
  await saveProject();
  const old = app.project;
  const base = old.name.replace(/ · v\d+$/, '');
  const all = await store.listProjects();
  let n = 2;
  while (all.some((p) => p.name === `${base} · v${n}`)) n++;
  app.project = { ...old, id: newId(), name: `${base} · v${n}`, created: Date.now(), proc: { ...old.proc } };
  app.assetsDirty = { photo: true, raw: true };
  $('projName').value = app.project.name;
  await saveProject();
  toast(`Saved as “${app.project.name}”. You are now editing this version; the original stays in the Gallery.`);
}
$('btnSnapshot').onclick = saveVersion;
$('projName').addEventListener('change', () => { if (app.project) { app.project.name = $('projName').value.trim() || 'Untitled'; scheduleSave(); } });

// ---- file inputs, drag & drop -------------------------------------------------------
$('btnOpen').onclick = () => $('fileInput').click();
$('emptyOpen').onclick = () => $('fileInput').click();
$('emptyDemo').onclick = openDemo;
$('fileInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openPhotoFile(f); };
$('depthInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importDepthMap(f); };
$('lookInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const look = { id: newId(), name: j.name || f.name.replace(/\.json$/, ''), s: j.settings || j.s || j };
    await store.saveLook(look);
    toast(`Look “${look.name}” added to your looks`);
    renderPanel(); loadLookThumbs();
  } catch (err) { toast('Not a valid look file: ' + err.message, true); }
};
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('dropHint').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('dropHint').hidden = true;
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (app.photo && /depth|disp|marigold/i.test(f.name)) importDepthMap(f);
  else openPhotoFile(f);
});
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) openPhotoFile(f);
});

// ---- keyboard ------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if ((tag === 'INPUT' && !['range', 'checkbox', 'radio', 'color'].includes(e.target.type)) || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if ($('exportDlg').open || $('galleryDlg').open || $('askDlg').open) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 's') { e.preventDefault(); saveVersion(); return; }
  if (mod && k === 'e') { e.preventDefault(); openExport(); return; }
  if (mod || e.altKey) return;
  if (k === 'o') $('fileInput').click();
  else if (k === 'g') openGallery();
  if (!app.photo) return;
  if (k === ' ') { e.preventDefault(); if (!e.repeat) togglePlay(); }
  else if (k === 'a') setView(0);
  else if (k === '\\') setView(app.view.mode === 1 ? 0 : 1);
  else if (k === 'd') setView(app.view.mode === 2 ? 0 : 2);
  else if (k === 'c') setView(app.view.mode === 3 ? 0 : 3);
  else if (k === 'h') setTool('hand');
  else if (k === 'p') setTool('pick');
  else if (k === 'f') setTool('frame');
  else if (k === '0') fit();
  else if (k === '1') $('zoom100').click();
  else if (k === 'n') addHighlighter();
  else if ((k === 'delete' || k === 'backspace') && selHL()) removeHighlighter(app.sel);
  else if ((k === '[' || k === ']' || k === 'arrowleft' || k === 'arrowright') && selHL() && e.target === vp) {
    e.preventDefault();
    const h = selHL(), st = e.shiftKey ? 0.01 : 0.002;
    h.center = clamp(h.center + (k === '[' || k === 'arrowleft' ? -st : st), 0, 1);
    onChange('hl'); syncEditor(); commitSoon();
  }
});
let commitT;
function commitSoon() { clearTimeout(commitT); commitT = setTimeout(commit, 500); }

// ---- highlighter operations -----------------------------------------------------------
function addHighlighter(over = {}) {
  if (!app.photo) return;
  if (app.s.highlighters.length >= MAX_HL) { toast(`Up to ${MAX_HL} highlighters`); return; }
  const used = app.s.highlighters.map((h) => h.center);
  const free = app.peaks.find((p) => used.every((u) => Math.abs(u - p) > 0.05)) ?? 0.5;
  const tpl = selHL();
  const h = newHighlighter({ ...(tpl ? { ...tpl } : {}), id: newId(), name: `Plane ${app.s.highlighters.length + 1}`, center: free, on: true, ...over });
  app.s.highlighters.push(h);
  app.sel = h.id;
  onChange('hl'); renderPanel(); commit();
}
function removeHighlighter(id) {
  const i = app.s.highlighters.findIndex((h) => h.id === id);
  if (i < 0) return;
  app.s.highlighters.splice(i, 1);
  if (app.sel === id) app.sel = app.s.highlighters[Math.min(i, app.s.highlighters.length - 1)]?.id || null;
  onChange('hl'); renderPanel(); commit();
}
function autoPlace() {
  const pk = subjectPeaks(app.depth.data, app.depth.w, app.depth.h, remap, Math.max(3, app.s.highlighters.length));
  const hl = app.s.highlighters;
  if (!hl.length) { addHighlighter({ center: pk[0] }); return; }
  hl.forEach((h, i) => { if (pk[i] != null) h.center = pk[i]; });
  onChange('hl'); renderPanel(); commit();
  toast('Highlighters moved to the detected subject distances');
}
function distribute(n) {
  const tpl = selHL() || newHighlighter();
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    out.push(newHighlighter({ ...tpl, id: newId(), name: `Stratum ${i + 1}`, center: 0.06 + t * 0.86, intensity: +(1 - t * 0.6).toFixed(2), on: true }));
  }
  app.s.highlighters = out;
  app.sel = out[0].id;
  onChange('hl'); renderPanel(); commit();
}

// ---- panel ------------------------------------------------------------------------------
// phone tabs: which panel sections each one shows
const TABS = { looks: ['looks'], bands: ['hl'], style: ['base', 'relief', 'contours', 'finish'], frame: ['frame', 'sig'], depth: ['depth', 'anim'] };
let mobile = false;
const ui = { tab: 'looks', open: true, h: 0.42 };
try { Object.assign(ui, JSON.parse(localStorage.getItem('vath.ui') || '{}')); } catch { /* ignore */ }
if (!TABS[ui.tab]) ui.tab = 'looks';
const saveUi = () => { try { localStorage.setItem('vath.ui', JSON.stringify({ tab: ui.tab, h: ui.h })); } catch { /* ignore */ } };
let openSecs;
try { openSecs = new Set(JSON.parse(localStorage.getItem('vath.open') || '["looks","hl","depth","base"]')); } catch { openSecs = new Set(['looks', 'hl', 'depth', 'base']); }
function section(id, title, build, count) {
  // phones show one tab of the panel at a time in the bottom sheet
  if (mobile && !TABS[ui.tab].includes(id)) return document.createComment(id);
  const d = el('details');
  d.open = openSecs.has(id);
  if (mobile && TABS[ui.tab].length === 1) { d.classList.add('solo'); d.open = true; }
  else if (mobile && TABS[ui.tab][0] === id) d.open = true;
  d.ontoggle = () => { d.open ? openSecs.add(id) : openSecs.delete(id); try { localStorage.setItem('vath.open', JSON.stringify([...openSecs])); } catch { /* ignore */ } };
  const s = el('summary', null, title);
  if (count != null) s.append(el('span', 'count', count));
  const body = el('div', 'sec');
  d.append(s, body);
  build(body);
  return d;
}
// slider bound to obj()[key]
function slider(parent, obj, key, label, o = {}) {
  const { min = 0, max = 1, step = 0.001, curve = 1, fmt = fmt2, def, title, kind = 'render' } = o;
  const row = el('div', 'row');
  const lab = el('label', null, label);
  if (title) lab.title = title;
  const r = document.createElement('input');
  r.type = 'range'; r.min = 0; r.max = 1000; r.step = 1;
  const toT = (v) => Math.pow(clamp((v - min) / (max - min), 0, 1), 1 / curve) * 1000;
  const fromT = (t) => min + (max - min) * Math.pow(t / 1000, curve);
  const val = el('input', 'val');
  val.type = 'text'; val.inputMode = 'decimal';
  const sync = () => { const v = obj()[key]; r.value = toT(v); val.value = fmt(v); };
  sync();
  r.setAttribute('aria-label', label);
  r.oninput = () => { let v = fromT(+r.value); v = Math.round(v / step) * step; obj()[key] = +v.toFixed(6); val.value = fmt(obj()[key]); onChange(kind); };
  r.onchange = () => commit();
  val.onchange = () => { const v = parseFloat(val.value.replace(',', '.')); if (Number.isFinite(v)) { obj()[key] = v; onChange(kind); commit(); } sync(); };
  lab.ondblclick = () => { if (def !== undefined) { obj()[key] = def; sync(); onChange(kind); commit(); } };
  if (def !== undefined) lab.title = (title ? title + '\n' : '') + 'Double-click to reset';
  row.append(lab, r, val);
  row.sync = sync;
  parent.append(row);
  return row;
}
function color(parent, obj, key, kind = 'render') {
  const c = document.createElement('input');
  c.type = 'color'; c.value = obj()[key];
  c.oninput = () => { obj()[key] = c.value; onChange(kind); };
  c.onchange = () => commit();
  parent.append(c);
  return c;
}
function select(parent, label, options, value, onSet) {
  const row = el('div', 'row wide');
  row.append(el('label', null, label));
  const s = document.createElement('select');
  for (const [v, t] of options) { const o = el('option', null, t); o.value = v; if (String(v) === String(value)) o.selected = true; s.append(o); }
  s.onchange = () => onSet(s.value);
  row.append(s);
  parent.append(row);
  return s;
}
function check(parent, label, value, onSet) {
  const l = el('label', 'check');
  const c = document.createElement('input');
  c.type = 'checkbox'; c.checked = !!value;
  c.onchange = () => onSet(c.checked);
  l.append(c, document.createTextNode(label));
  parent.append(l);
  return c;
}
function chips(parent, items, cur, onSet) {
  const box = el('div', 'chips');
  for (const [v, t, tip] of items) {
    const b = el('button', String(v) === String(cur) ? 'on' : '', t);
    b.type = 'button';
    if (tip) b.title = tip;
    b.onclick = () => onSet(v);
    box.append(b);
  }
  parent.append(box);
  return box;
}
function button(parent, text, fn, cls = 'btn') { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; parent.append(b); return b; }

let editorRows = [];
function syncEditor() { for (const r of editorRows) r.sync?.(); updateHlMeta(); }
function updateHlMeta() {
  for (const m of document.querySelectorAll('.hl .meta')) {
    const h = app.s.highlighters.find((x) => x.id === m.dataset.id);
    if (h) m.textContent = h.center.toFixed(3);
  }
}

function renderPanel() {
  const P = $('panel');
  const scroll = P.scrollTop;
  P.textContent = '';
  if (!app.photo) {
    const d = el('div', 'sec');
    d.style.padding = '18px 16px';
    d.append(el('p', 'hint', 'Open a photo or try the demo. Controls appear here.'));
    P.append(d);
    return;
  }
  const S = () => app.s;
  editorRows = [];

  // Looks
  P.append(section('looks', 'Looks', (b) => {
    const grid = el('div', 'looks');
    grid.id = 'looksGrid';
    for (const look of LOOKS) grid.append(lookTile(look, false));
    for (const look of userLooks) grid.append(lookTile(look, true));
    b.append(grid);
    const bt = el('div', 'btns');
    button(bt, 'Save current as look…', saveCurrentLook);
    button(bt, 'Import look…', () => $('lookInput').click());
    b.append(bt);
  }));

  // Highlighters
  P.append(section('hl', 'Depth highlighters', (b) => {
    const bt = el('div', 'btns');
    button(bt, '+ Add', () => addHighlighter());
    button(bt, 'Auto-place on subjects', autoPlace).title = 'Find the distances where subjects stand and move the highlighters there';
    b.append(bt);
    const dist = el('div', 'btns');
    dist.append(el('span', 'hint', 'Strata:'));
    for (const n of [3, 5, 8]) button(dist, `${n} evenly`, () => distribute(n)).title = `Replace highlighters with ${n} evenly spaced planes, fading with distance`;
    b.append(dist);
    const list = el('div', 'hl-list');
    for (const h of app.s.highlighters) {
      const it = el('div', 'hl' + (h.id === app.sel ? ' sel' : '') + (h.on ? '' : ' off'));
      const sw = el('span', 'sw'); sw.style.background = h.color;
      const meta = el('span', 'meta', h.center.toFixed(3)); meta.dataset.id = h.id;
      const eye = el('button', 'ib', h.on ? '◉' : '○'); eye.title = h.on ? 'Hide' : 'Show';
      eye.onclick = (e) => { e.stopPropagation(); h.on = !h.on; onChange('hl'); renderPanel(); commit(); };
      const dup = el('button', 'ib', '⧉'); dup.title = 'Duplicate';
      dup.onclick = (e) => { e.stopPropagation(); app.sel = h.id; addHighlighter({ center: clamp(h.center + 0.05, 0, 1), name: h.name + ' copy' }); };
      const del = el('button', 'ib', '×'); del.title = 'Delete';
      del.onclick = (e) => { e.stopPropagation(); removeHighlighter(h.id); };
      it.append(sw, el('span', 'nm', h.name), meta, eye, dup, del);
      it.onclick = () => { app.sel = h.id; renderPanel(); renderBands(); };
      list.append(it);
    }
    if (!app.s.highlighters.length) list.append(el('p', 'hint', 'No highlighters: the artwork shows only the atmosphere. Add one, or double-click the depth ruler.'));
    b.append(list);
    const h = selHL();
    if (h) {
      const ed = el('div', 'editor');
      const H = () => selHL() || h;
      const nm = el('input'); nm.type = 'text'; nm.value = h.name;
      nm.onchange = () => { H().name = nm.value || 'Highlighter'; renderBands(); renderPanel(); commit(); };
      const r0 = el('div', 'row wide'); r0.append(el('label', null, 'Name'), nm); ed.append(r0);
      const r1 = el('div', 'row wide'); r1.append(el('label', null, 'Style'));
      chips(r1, [['solid', 'Solid', 'Flat colour band, optionally textured by the photo'], ['photo', 'Photo', 'Reveal the original photograph inside the band'], ['line', 'Line', 'A single crisp iso-distance line']], h.style, (v) => { H().style = v; onChange('hl'); renderPanel(); commit(); });
      ed.append(r1);
      editorRows.push(slider(ed, H, 'center', 'Distance', { def: 0.35, fmt: fmt3, kind: 'hl', title: 'Which distance lights up: 0 nearest, 1 farthest. Also: Pick tool, or drag in the ruler.' }));
      if (h.style !== 'line') {
        editorRows.push(slider(ed, H, 'width', 'Width', { min: 0.001, max: 0.6, curve: 2.2, fmt: fmt3, def: HL_DEF.width, kind: 'hl', title: 'How deep the slice of space is' }));
        editorRows.push(slider(ed, H, 'feather', 'Softness', { min: 0, max: 0.3, curve: 2.2, fmt: fmt3, def: HL_DEF.feather, title: 'Soft fall-off at the band edges' }));
      } else editorRows.push(slider(ed, H, 'thickness', 'Thickness', { min: 0.2, max: 12, curve: 1.6, fmt: fmt2, def: HL_DEF.thickness, title: 'Line thickness in ‰ of the artwork height (same look at every print size)' }));
      editorRows.push(slider(ed, H, 'intensity', 'Intensity', { min: 0, max: 2, def: 1 }));
      editorRows.push(slider(ed, H, 'opacity', 'Opacity', { def: 1 }));
      if (h.style === 'solid') editorRows.push(slider(ed, H, 'detail', 'Photo texture', { def: HL_DEF.detail, title: '0: flat colour · 1: the band carries the photo’s light and texture' }));
      if (h.style === 'photo') editorRows.push(slider(ed, H, 'tint', 'Colour tint', { def: 0, title: 'Tint the revealed photo with the highlighter colour' }));
      editorRows.push(slider(ed, H, 'glow', 'Depth glow', { def: 0, title: 'A halo that spreads into neighbouring distances' }));
      if (h.glow > 0) editorRows.push(slider(ed, H, 'glowRadius', 'Glow reach', { min: 0.002, max: 0.4, curve: 2, fmt: fmt3, def: HL_DEF.glowRadius }));
      const r2 = el('div', 'row wide'); r2.append(el('label', null, 'Colour'));
      const cc = el('div', 'colors');
      color(cc, H, 'color', 'hl');
      for (const c of ['#ffffff', '#f3e3c3', '#ff2fa3', '#2fe6ff', '#ffb02f', '#c8321e', '#000000']) {
        const s = el('button', 'ib sw-btn'); s.type = 'button'; s.title = c;
        s.style.cssText = `width:18px;height:18px;border-radius:4px;background:${c};border:1px solid #444;padding:0`;
        s.onclick = () => { H().color = c; onChange('hl'); renderPanel(); commit(); };
        cc.append(s);
      }
      r2.append(cc); ed.append(r2);
      select(ed, 'Blend', [['screen', 'Screen (light)'], ['add', 'Add (glow)'], ['normal', 'Normal (paint over)'], ['multiply', 'Multiply (ink)']], h.blend, (v) => { H().blend = v; onChange('hl'); commit(); });
      b.append(ed);
    }
  }, `${app.s.highlighters.length}/${MAX_HL}`));

  // Depth
  P.append(section('depth', 'Depth', (b) => {
    const D = () => S().depth;
    slider(b, D, 'near', 'Near clip', { def: 0, fmt: fmt3, kind: 'depth', title: 'Everything nearer than this counts as distance 0' });
    slider(b, D, 'far', 'Far clip', { def: 1, fmt: fmt3, kind: 'depth', title: 'Everything farther than this counts as distance 1' });
    slider(b, D, 'gamma', 'Spread', { min: 0.25, max: 4, curve: 2, def: 1, kind: 'depth', title: 'Stretch near (<1) or far (>1) distances across the ruler' });
    check(b, 'Invert near / far', D().invert, (v) => { D().invert = v; onChange('depth'); commit(); });
    slider(b, D, 'edgeClean', 'Clean edges', { def: 0.85, title: 'Hide the thin halos where depth jumps at object outlines (0 keeps them as an outline effect)' });
    const p = app.project.proc;
    const src = { ai: 'AI estimate', import: 'Imported depth map', fallback: 'Fallback gradient (no AI)' }[p.source] || p.source;
    b.append(el('p', 'hint', `Source: ${src} · ${app.raw.w}×${app.raw.h} → rendered at ${app.depth?.w}×${app.depth?.h}`));
    select(b, 'AI model', Object.entries(MODELS).map(([k, m]) => [k, m.label]), p.model, (v) => { p.model = v; scheduleSave(); });
    select(b, 'AI detail', Object.entries(DETAIL).map(([k, m]) => [k, m.label]), p.detail, (v) => { p.detail = v; scheduleSave(); });
    const bt = el('div', 'btns');
    button(bt, p.source === 'ai' ? 'Re-estimate depth' : 'Estimate with AI', async () => { await runAI(); await refineDepth(); idle(); renderPanel(); scheduleSave(); });
    button(bt, 'Import depth map…', () => $('depthInput').click()).title = 'PNG (8 or 16-bit) from Marigold, Depth Anything, Photoshop, an iPhone portrait… White = near.';
    b.append(bt);
    check(b, 'Snap depth edges to the photo', p.refine, (v) => { p.refine = v; reRefine(); });
    if (p.refine) {
      const PR = () => p;
      const rs = slider(b, PR, 'snap', 'Edge snap', { def: 0.6, kind: 'none', title: 'How tightly depth follows edges in the photo (hair, branches, silhouettes)' });
      const rr = slider(b, PR, 'radius', 'Edge reach', { min: 0.3, max: 3, def: 1, kind: 'none', title: 'How far an edge can pull the depth' });
      for (const r of [rs, rr]) r.querySelector('input[type=range]').addEventListener('change', reRefine);
    }
    const resOpts = [2048, 3072, 4096, 6144, 8192].filter((r) => r <= renderer.maxTex).map((r) => [r, `${r} px${r === 4096 ? ' (default)' : r >= 6144 ? ' (huge prints, more memory)' : ''}`]);
    select(b, 'Depth resolution', resOpts, p.refineRes, (v) => { p.refineRes = +v; reRefine(); });
  }));

  // Atmosphere
  P.append(section('base', 'Atmosphere', (b) => {
    const B = () => S().base;
    const r = el('div', 'row wide'); r.append(el('label', null, 'Near · mid · far'));
    const cc = el('div', 'colors');
    color(cc, B, 'near', 'base'); color(cc, B, 'mid', 'base'); color(cc, B, 'far', 'base');
    r.append(cc); b.append(r);
    chips(b, [
      ['black', 'Black'], ['mist', 'Mist'], ['night', 'Night fog'], ['paper', 'Paper'], ['sepia', 'Sepia'], ['blue', 'Cyanotype'], ['white', 'White'],
    ], '', (v) => {
      const P2 = { black: ['#000000', '#000000', '#000000'], mist: ['#0b0b0c', '#5c5d60', '#ecebe7'], night: ['#e9e7e2', '#3d3e42', '#030304'], paper: ['#efe9dd', '#efe9dd', '#efe9dd'], sepia: ['#140d07', '#6b5139', '#e6d3b3'], blue: ['#0b2a52', '#1d4f86', '#c7dcf2'], white: ['#ffffff', '#ffffff', '#ffffff'] }[v];
      Object.assign(B(), { near: P2[0], mid: P2[1], far: P2[2] });
      onChange('base'); renderPanel(); commit();
    });
    slider(b, B, 'midPos', 'Mid point', { def: 0.5, kind: 'base' });
    slider(b, B, 'curve', 'Fog curve', { min: 0.2, max: 4, curve: 2, def: 1, kind: 'base', title: 'How quickly the atmosphere thickens with distance' });
    slider(b, B, 'detail', 'Photo texture', { def: 0, title: 'Let the photo’s light and texture shape the atmosphere' });
    slider(b, B, 'photo', 'Photo mix', { def: 0, title: 'Blend the original photograph into the base' });
    slider(b, B, 'photoSat', 'Photo colour', { def: 0, title: '0: the mixed-in photo is black & white' });
  }));

  // Relief
  P.append(section('relief', 'Relief', (b) => {
    const R = () => S().relief;
    slider(b, R, 'amount', 'Amount', { def: 0, title: 'Light the depth surface like a sculpture' });
    slider(b, R, 'angle', 'Light angle', { min: 0, max: 360, step: 1, fmt: fmtDeg, def: 135 });
    slider(b, R, 'radius', 'Scale', { min: 0.5, max: 12, curve: 1.6, def: 2, title: 'Fine (small) or broad (large) relief' });
  }));

  // Contours
  P.append(section('contours', 'Contour lines', (b) => {
    const C = () => S().contours;
    check(b, 'Draw iso-distance lines', C().on, (v) => { C().on = v; onChange('render'); commit(); });
    slider(b, C, 'count', 'Lines', { min: 2, max: 120, step: 1, curve: 1.5, fmt: fmt0, def: 16 });
    slider(b, C, 'thickness', 'Thickness', { min: 0.2, max: 6, curve: 1.6, def: 0.8, title: '‰ of the artwork height' });
    slider(b, C, 'opacity', 'Opacity', { def: 0.6 });
    const r = el('div', 'row wide'); r.append(el('label', null, 'Colour')); const cc = el('div', 'colors'); color(cc, C, 'color'); r.append(cc); b.append(r);
  }));

  // Finish
  P.append(section('finish', 'Finish', (b) => {
    const F = () => S().finish;
    slider(b, F, 'exposure', 'Exposure', { min: 0.2, max: 2.5, curve: 1.4, def: 1 });
    slider(b, F, 'contrast', 'Contrast', { min: 0.4, max: 2, def: 1 });
    slider(b, F, 'saturation', 'Saturation', { min: 0, max: 2, def: 1 });
    slider(b, F, 'vignette', 'Vignette', { def: 0 });
    slider(b, F, 'grain', 'Film grain', { def: 0, title: 'Grain is defined relative to the artwork, so prints and posts match' });
    slider(b, F, 'grainSize', 'Grain size', { min: 0.3, max: 4, def: 1 });
    const bt = el('div', 'btns');
    button(bt, 'New grain pattern', () => { F().seed = Math.floor(Math.random() * 1000); onChange('render'); commit(); });
    b.append(bt);
  }));

  // Frame
  P.append(section('frame', 'Frame & crop', (b) => {
    const F = () => S().frame;
    const asp = F().aspect;
    const opts = Object.keys(ASPECTS).map((k) => [k, k === 'original' ? 'Original' : k === 'phone' ? 'Phone wallpaper' : k]);
    if (typeof asp === 'number') opts.push([asp, `Paper ${asp.toFixed(3)}`]);
    select(b, 'Aspect', opts, asp, (v) => { F().aspect = isNaN(+v) ? v : +v; onChange('frame'); fit(); renderPanel(); commit(); });
    chips(b, [['4:5', 'IG 4:5'], ['1:1', '1:1'], ['9:16', 'Story'], ['3:2', '3:2'], ['2:3', '2:3'], ['A (1:√2)', 'A-paper'], ['original', 'Original']], asp, (v) => { F().aspect = v; onChange('frame'); fit(); renderPanel(); commit(); });
    if (asp !== 'original') {
      const r = el('div', 'row wide'); r.append(el('label', null, 'Fit'));
      chips(r, [['crop', 'Crop to fill'], ['contain', 'Whole photo']], F().fit, (v) => { F().fit = v; onChange('frame'); renderPanel(); commit(); });
      b.append(r);
    }
    if (F().fit !== 'contain' || asp === 'original') {
      slider(b, F, 'zoom', 'Crop zoom', { min: 1, max: 4, curve: 1.5, def: 1, kind: 'frame' });
      b.append(el('p', 'hint', coarse.matches ? 'Crop tool: drag the photo to move the crop, pinch to zoom it.' : 'Use the ⬚ Crop tool (F) to drag the composition.'));
    }
    slider(b, F, 'border', 'Border', { min: 0, max: 0.2, curve: 1.5, fmt: fmt3, def: 0, kind: 'frame', title: 'Gallery mat around the artwork, as a fraction of the short side' });
    slider(b, F, 'borderBottom', 'Extra bottom', { min: 0, max: 0.2, curve: 1.5, fmt: fmt3, def: 0, kind: 'frame', title: 'Extra space at the bottom: room for a title or signature' });
    const r = el('div', 'row wide'); r.append(el('label', null, 'Border colour')); const cc = el('div', 'colors'); color(cc, F, 'borderColor'); r.append(cc); b.append(r);
  }));

  // Signature
  P.append(section('sig', 'Signature', (b) => {
    const G = () => S().signature;
    check(b, 'Sign the artwork', G().on, (v) => { G().on = v; onChange('sig'); renderPanel(); commit(); });
    const r = el('div', 'row wide'); r.append(el('label', null, 'Text'));
    const t = el('input'); t.type = 'text'; t.value = G().text; t.placeholder = 'Your name · 2026';
    t.oninput = () => { G().text = t.value; if (!G().on && t.value) G().on = true; onChange('sig'); };
    t.onchange = () => { commit(); renderPanel(); };
    r.append(t); b.append(r);
    select(b, 'Font', [['Cormorant Garamond', 'Cormorant (serif)'], ['Playfair Display', 'Playfair (display)'], ['Inter', 'Inter (sans)'], ['Space Grotesk', 'Space Grotesk'], ['Caveat', 'Caveat (handwritten)']], G().font, (v) => { G().font = v; onChange('sig'); commit(); });
    check(b, 'Italic', G().italic, (v) => { G().italic = v; onChange('sig'); commit(); });
    select(b, 'Position', [['br', 'Bottom right'], ['bc', 'Bottom centre'], ['bl', 'Bottom left'], ['tr', 'Top right'], ['tl', 'Top left']], G().position, (v) => { G().position = v; onChange('sig'); commit(); });
    slider(b, G, 'size', 'Size', { min: 0.8, max: 8, curve: 1.4, def: 2.2, kind: 'sig', title: '% of the artwork height' });
    slider(b, G, 'spacing', 'Letter spacing', { min: 0, max: 0.6, def: 0.08, kind: 'sig' });
    slider(b, G, 'opacity', 'Opacity', { def: 0.85 });
    const r2 = el('div', 'row wide'); r2.append(el('label', null, 'Colour')); const cc = el('div', 'colors'); color(cc, G, 'color'); r2.append(cc); b.append(r2);
    b.append(el('p', 'hint', 'Add a border with extra bottom space (Frame) to sign below the image, gallery style.'));
  }));

  // Animation
  P.append(section('anim', 'Animation', (b) => animControls(b)));

  P.scrollTop = scroll;
}

function animControls(b) {
  const A = () => app.s.anim;
  select(b, 'Motion', [['sweep', 'Sweep: a plane travels through space'], ['drift', 'Drift: all planes float'], ['breathe', 'Breathe: bands widen and narrow']], A().mode, (v) => { A().mode = v; commit(); renderPanel(); refreshExportIfOpen(); });
  if (A().mode === 'sweep') {
    select(b, 'Moves', [['all', 'All highlighters together'], ...app.s.highlighters.map((h) => [h.id, h.name])], A().target, (v) => { A().target = v; commit(); });
    slider(b, A, 'from', 'From', { def: 0.05, fmt: fmt3, kind: 'none' });
    slider(b, A, 'to', 'To', { def: 0.9, fmt: fmt3, kind: 'none' });
  }
  if (A().mode === 'drift') slider(b, A, 'range', 'Range', { min: 0.01, max: 0.5, def: 0.12, kind: 'none' });
  slider(b, A, 'duration', 'Seconds', { min: 1, max: 30, step: 0.5, fmt: (v) => (+v).toFixed(1), def: 6, kind: 'none', title: 'Length of one pass' });
  select(b, 'Loop', [['pingpong', 'Ping-pong (seamless loop)'], ['once', 'Once']], A().loop, (v) => { A().loop = v; commit(); });
  const bt = el('div', 'btns');
  button(bt, app.playing ? '■ Stop preview' : '▶ Preview', () => { togglePlay(); renderPanel(); });
  b.append(bt);
  b.append(el('p', 'hint', 'Export ▸ Video records it for Reels, TikTok and Shorts.'));
}

// ---- looks ------------------------------------------------------------------------------
let userLooks = [];
async function loadUserLooks() { try { userLooks = await store.listLooks(); } catch { userLooks = []; } }
const lookThumbs = new Map();
function lookTile(look, user) {
  const b = el('button', 'look' + (app.look === (look.id || look.name) ? ' on' : ''));
  b.type = 'button';
  b.title = look.desc || look.name;
  const img = el('img', 'thumb');
  img.alt = '';
  const src = lookThumbs.get(look.id || look.name);
  if (src) img.src = src;
  img.dataset.key = look.id || look.name;
  b.append(img, el('span', null, look.name));
  b.onclick = () => {
    app.s = user ? normalize({ ...app.s, ...look.s, frame: app.s.frame, signature: app.s.signature, anim: app.s.anim }) : applyLook(app.s, look, app.peaks);
    app.sel = app.s.highlighters[0]?.id || null;
    app.look = look.id || look.name;
    try { if (!user) localStorage.setItem('vath.lastLook', look.name); } catch { /* ignore */ }
    recomputeHist(); renderPanel(); requestRender(); commit();
  };
  if (user) {
    const x = el('span', 'del', '×'); x.title = 'Delete look';
    x.onclick = async (e) => { e.stopPropagation(); if (!confirm(`Delete the look “${look.name}”?`)) return; await store.deleteLook(look.id); await loadUserLooks(); renderPanel(); };
    b.append(x);
  }
  return b;
}
let thumbGen = 0;
async function loadLookThumbs() {
  if (!app.photo || !app.depth) return;
  const gen = ++thumbGen;
  await loadUserLooks();
  renderPanel();
  const L0 = computeLayout({ ...app.s.frame, border: 0, borderBottom: 0, aspect: '4:3', fit: 'crop', zoom: 1, cx: 0.5, cy: 0.5 }, app.photo.w, app.photo.h, null);
  const all = [...LOOKS.map((l) => [l.name, applyLook(app.s, l, app.peaks)]), ...userLooks.map((l) => [l.id, normalize({ ...app.s, ...l.s })])];
  for (const [key, s] of all) {
    await new Promise((r) => setTimeout(r, 0));
    if (gen !== thumbGen) return;
    const c = renderer.renderToCanvas({ ...s, signature: { ...s.signature, on: false } }, L0, 200, { hiQ: false });
    const url = c.toDataURL('image/jpeg', 0.8);
    lookThumbs.set(key, url);
    const img = document.querySelector(`#looksGrid img[data-key="${CSS.escape(key)}"]`);
    if (img) img.src = url;
  }
}
// in-page replacement for prompt(), which desktop (Electron) builds do not support
function askText(title, value = '') {
  const dlg = $('askDlg'), input = $('askInput');
  $('askTitle').textContent = title;
  input.value = value;
  dlg.returnValue = '';
  for (const b of dlg.querySelectorAll('[data-close]')) b.onclick = () => dlg.close('');
  showDialog(dlg);
  if (!mobile) input.select();
  return new Promise((resolve) => { dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null); });
}
async function saveCurrentLook() {
  const name = await askText('Name this look', 'My look');
  if (!name) return;
  const s = JSON.parse(snapshot());
  const look = { id: newId(), name, s: { depth: s.depth, base: s.base, relief: s.relief, contours: s.contours, finish: s.finish, highlighters: s.highlighters } };
  await store.saveLook(look);
  await loadUserLooks();
  loadLookThumbs();
  toast(`Look “${name}” saved`);
}

// ---- gallery ------------------------------------------------------------------------------
async function openGallery() {
  if (app.project) await saveProject();
  await renderGallery();
  showDialog($('galleryDlg'));
}
$('btnGallery').onclick = openGallery;
$('galleryClose').onclick = () => $('galleryDlg').close();
async function renderGallery() {
  const grid = $('galleryGrid');
  grid.textContent = '';
  const list = await store.listProjects();
  const u = await store.usage();
  $('usage').textContent = u ? `${list.length} artworks · ${(u.usage / 1e6).toFixed(0)} MB used on this device` : '';
  if (!list.length) { grid.append(el('div', 'none', 'No saved artworks yet. Every photo you open is saved here automatically.')); return; }
  for (const p of list) {
    const c = el('div', 'card');
    const img = el('img');
    img.alt = p.name;
    if (p.thumb) img.src = URL.createObjectURL(p.thumb);
    img.onclick = () => { $('galleryDlg').close(); openProject(p.id); };
    const info = el('div', 'info');
    info.append(el('div', 't', p.name), el('div', 'd', `${new Date(p.updated).toLocaleString()} · ${p.w}×${p.h}${app.project?.id === p.id ? ' · open' : ''}`));
    const cb = el('div', 'cb');
    button(cb, 'Open', () => { $('galleryDlg').close(); openProject(p.id); });
    button(cb, 'Duplicate', async () => {
      const full = await store.getProject(p.id);
      const id = newId();
      await store.saveProject({ ...p, id, name: p.name + ' copy', created: Date.now(), updated: Date.now() }, { photo: full.photo, raw: full.raw });
      renderGallery();
    });
    button(cb, 'Delete', async () => {
      if (!confirm(`Delete “${p.name}” from this device? This cannot be undone.`)) return;
      await store.deleteProject(p.id);
      if (app.project?.id === p.id) { app.project = null; location.reload(); return; }
      renderGallery(); renderRecent();
    }, 'btn danger');
    c.append(img, info, cb);
    grid.append(c);
  }
}
async function renderRecent() {
  const box = $('recent');
  box.textContent = '';
  try {
    const list = (await store.listProjects()).slice(0, 6);
    if (!list.length) return;
    for (const p of list) {
      const b = el('button');
      b.title = p.name;
      const img = el('img'); img.alt = ''; if (p.thumb) img.src = URL.createObjectURL(p.thumb);
      b.append(img, el('span', null, p.name));
      b.onclick = () => openProject(p.id);
      box.append(b);
    }
  } catch { /* storage unavailable */ }
}

// ---- export dialog ---------------------------------------------------------------------------
const exp = { tab: 'print', paper: 'a2', dpi: 300, format: 'png16', social: 'ig-portrait', socialFmt: 'jpeg', longEdge: 6000, customFmt: 'png', toDisk: false, vWidth: 1080, fps: 30 };
try { Object.assign(exp, JSON.parse(localStorage.getItem('vath.export') || '{}')); } catch { /* ignore */ }
const saveExp = () => { try { localStorage.setItem('vath.export', JSON.stringify(exp)); } catch { /* ignore */ } };
function openExport() {
  if (!app.photo) return;
  renderExport();
  showDialog($('exportDlg'));
}
$('btnExport').onclick = openExport;
$('exportTabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  exp.tab = b.dataset.tab; saveExp(); renderExport();
};
function refreshExportIfOpen() { if ($('exportDlg').open) renderExport(); }
function fileBase() { return (app.project?.name || 'vathograph').replace(/[^\w\- ·]+/g, '').replace(/\s+/g, '-'); }
function radioOpts(parent, name, items, cur, onSet) {
  const box = el('div', 'opts');
  for (const [v, title, sub] of items) {
    const l = el('label', 'opt');
    const r = document.createElement('input'); r.type = 'radio'; r.name = name; r.value = v; r.checked = String(v) === String(cur);
    r.onchange = () => onSet(v);
    const t = el('div'); t.append(document.createTextNode(title)); if (sub) t.append(el('small', null, sub));
    l.append(r, t); box.append(l);
  }
  parent.append(box);
  return box;
}
const FORMATS = [
  ['png16', 'PNG 16-bit', 'Smoothest gradients, lossless. Best master for print labs.'],
  ['tiff16', 'TIFF 16-bit', 'Uncompressed. Accepted by every print lab and RIP.'],
  ['tiff', 'TIFF 8-bit', 'Uncompressed, universal.'],
  ['png', 'PNG 8-bit', 'Lossless, smaller.'],
  ['jpeg', 'JPEG (max quality)', 'Smallest file, fine for most labs.'],
];
function estSize(w, h, f) {
  const px = w * h;
  const b = { png16: 2.6, tiff16: 6, tiff: 3, png: 1.3, jpeg: 0.45 }[f] * px;
  return b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB';
}
function renderExport() {
  for (const b of $('exportTabs').children) b.classList.toggle('on', b.dataset.tab === exp.tab);
  const body = $('exportBody');
  body.textContent = '';
  const L = layout();
  const go = el('div', 'dlg-actions');
  const run = (label, fn) => { const b = button(go, label, fn, 'btn primary big'); return b; };

  if (exp.tab === 'print') {
    const portrait = L.artW < 1;
    const paper = PRINT_SIZES.find((p) => p.id === exp.paper) || PRINT_SIZES[2];
    const pw = portrait ? Math.min(paper.w, paper.h) : Math.max(paper.w, paper.h), ph = portrait ? Math.max(paper.w, paper.h) : Math.min(paper.w, paper.h);
    select(body, 'Paper', PRINT_SIZES.map((p) => [p.id, p.label]), paper.id, (v) => { exp.paper = v; saveExp(); renderExport(); });
    select(body, 'Resolution', [[150, '150 dpi · posters seen from afar'], [200, '200 dpi · large canvas'], [240, '240 dpi · fine art (Epson)'], [300, '300 dpi · gallery standard'], [360, '360 dpi · close viewing']], exp.dpi, (v) => { exp.dpi = +v; saveExp(); renderExport(); });
    const pa = pw / ph;
    // fit the artwork inside the paper
    let wCm = pw, hCm = pw / L.artW;
    if (hCm > ph) { hCm = ph; wCm = ph * L.artW; }
    const w = Math.round(wCm / 2.54 * exp.dpi), h = Math.round(hCm / 2.54 * exp.dpi);
    const mismatch = Math.abs(pa - L.artW) / pa > 0.01;
    if (mismatch) {
      const n = el('div', 'summary');
      n.append(el('span', 'warn', `The artwork (${L.artW.toFixed(3)}) and the paper (${pa.toFixed(3)}) have different proportions. It prints at ${wCm.toFixed(1)} × ${hCm.toFixed(1)} cm with white paper around it. `));
      const b = button(n, 'Match the frame to this paper', () => { app.s.frame.aspect = +pa.toFixed(5); onChange('frame'); fit(); renderPanel(); commit(); renderExport(); });
      b.style.marginTop = '6px';
      body.append(n);
    }
    body.append(el('h4', 'muted', 'Format'));
    radioOpts(body, 'fmt', FORMATS, exp.format, (v) => { exp.format = v; saveExp(); renderExport(); });
    const ppi = L.srcRect.h * renderer.photoSize[1] / (hCm * L.imgRect.h / 2.54);
    const sum = el('div', 'summary');
    sum.innerHTML = `Output <b>${w.toLocaleString()} × ${h.toLocaleString()} px</b> (${(w * h / 1e6).toFixed(1)} MP) · ${wCm.toFixed(1)} × ${hCm.toFixed(1)} cm at ${exp.dpi} dpi · ≈ ${estSize(w, h, exp.format)}<br>` +
      `Photo detail: ${Math.round(ppi)} ppi native → ${ppi >= exp.dpi * 0.9 ? '<span class="ok">full resolution</span>' : `<span class="warn">upscaled ${(exp.dpi / ppi).toFixed(1)}×</span>. Depth bands, lines, gradients and grain are rendered natively at ${exp.dpi} dpi and stay crisp; photo texture inside bands is smoothly interpolated.`}`;
    body.append(sum);
    addDiskOption(body, w * h);
    if (exp.format === 'jpeg' && w * h > 260e6) body.append(el('p', 'hint warn', 'JPEG over ~260 MP is beyond browser canvas limits; choose PNG or TIFF.'));
    run(`Export ${w}×${h}`, () => doExport(w, h, exp.format, exp.dpi, `${fileBase()}_${paper.id}_${exp.dpi}dpi`));
  } else if (exp.tab === 'social') {
    radioOpts(body, 'social', SOCIAL.map((s) => [s.id, s.label]), exp.social, (v) => {
      exp.social = v; saveExp();
      const so = SOCIAL.find((s) => s.id === v);
      if (app.s.frame.aspect !== so.aspect) { app.s.frame.aspect = so.aspect; onChange('frame'); fit(); renderPanel(); commit(); }
      renderExport();
    });
    const so = SOCIAL.find((s) => s.id === exp.social) || SOCIAL[0];
    const L2 = layout();
    const w = so.w, h = Math.round(so.w / L2.artW);
    const n = el('div', 'summary');
    n.innerHTML = `Output <b>${w} × ${h} px</b>, sRGB. Choosing a format sets the frame aspect; adjust the crop in the studio (⬚ Crop tool) and come back.` + (app.s.frame.aspect !== so.aspect ? '<br><span class="warn">The current frame aspect differs from this format.</span>' : '');
    body.append(n);
    select(body, 'File', [['jpeg', 'JPEG 95% (recommended for upload)'], ['png', 'PNG (lossless)']], exp.socialFmt, (v) => { exp.socialFmt = v; saveExp(); });
    run('Export for social', () => doExport(w, h, exp.socialFmt, 72, `${fileBase()}_${so.id}`));
  } else if (exp.tab === 'custom') {
    const r = el('div', 'row'); r.style.gridTemplateColumns = '130px 1fr';
    r.append(el('label', null, 'Long edge (px)'));
    const inp = el('input', 'val'); inp.type = 'number'; inp.min = 64; inp.max = 60000; inp.value = exp.longEdge; inp.style.width = '120px';
    r.append(inp); body.append(r);
    chips(body, [[2048, '2K'], [4096, '4K'], [6000, '6K'], [8192, '8K'], [12000, '12K'], [16384, '16K'], [24000, '24K']], exp.longEdge, (v) => { exp.longEdge = v; saveExp(); renderExport(); });
    const dims = () => { const le = clamp(+inp.value || 4096, 64, 60000); return L.artW >= 1 ? [le, Math.round(le / L.artW)] : [Math.round(le * L.artW), le]; };
    const sum = el('div', 'summary');
    const upd = () => { const [w, h] = dims(); sum.innerHTML = `Output <b>${w.toLocaleString()} × ${h.toLocaleString()} px</b> (${(w * h / 1e6).toFixed(1)} MP) · ≈ ${estSize(w, h, exp.customFmt)}`; };
    inp.oninput = () => { exp.longEdge = +inp.value; saveExp(); upd(); };
    upd();
    body.append(el('h4', 'muted', 'Format'));
    radioOpts(body, 'cfmt', FORMATS, exp.customFmt, (v) => { exp.customFmt = v; saveExp(); upd(); });
    body.append(sum);
    addDiskOption(body, dims()[0] * dims()[1]);
    run('Export', () => { const [w, h] = dims(); doExport(w, h, exp.customFmt, exp.dpi, `${fileBase()}_${Math.max(w, h)}px`); });
  } else if (exp.tab === 'video') {
    const mime = videoMime();
    if (!mime) body.append(el('p', 'warn', 'This browser cannot record video. Use Chrome, Edge or a recent Safari/Firefox.'));
    const box = el('div', 'sec'); box.style.padding = '0';
    animControls(box);
    body.append(box);
    select(body, 'Width', [[720, '720 px'], [1080, '1080 px (Instagram, TikTok)'], [1440, '1440 px'], [2160, '2160 px (4K)']], exp.vWidth, (v) => { exp.vWidth = +v; saveExp(); renderExport(); });
    select(body, 'Frame rate', [[30, '30 fps'], [60, '60 fps']], exp.fps, (v) => { exp.fps = +v; saveExp(); });
    const w = exp.vWidth & ~1, h = Math.round(w / L.artW) & ~1;
    const A = app.s.anim, secs = A.loop === 'once' ? A.duration : A.duration * (A.cycles || 2);
    const n = el('div', 'summary');
    n.innerHTML = `Video <b>${w} × ${h}</b> · ${secs.toFixed(1)} s · ${mime ? mime.split(';')[0].replace('video/', '').toUpperCase() : '—'}. Records in real time; keep this tab visible.` + (Math.abs(L.artW - 9 / 16) > 0.01 && Math.abs(L.artW - 4 / 5) > 0.01 ? '<br><span class="muted">Tip: set the frame to Story (9:16) or 4:5 for Reels and TikTok.</span>' : '');
    body.append(n);
    run('Record video', () => doVideo(w, h)).disabled = !mime;
  } else if (exp.tab === 'extras') {
    body.append(el('p', 'muted', 'Depth map: the refined depth as a 16-bit greyscale PNG (white = near), for Photoshop lens blur, Blender, After Effects, or as an artwork itself.'));
    const b1 = el('div', 'btns');
    button(b1, `Depth map PNG 16-bit (${app.depth.w}×${app.depth.h})`, async () => {
      busy('Encoding depth map…');
      const inv = new Float32Array(app.depth.data.length);
      for (let i = 0; i < inv.length; i++) inv[i] = 1 - remap(app.depth.data[i]);
      await download(await depthToPNG(inv, app.depth.w, app.depth.h), `${fileBase()}_depth16.png`);
      idle();
    });
    body.append(b1);
    body.append(el('p', 'muted', 'Look: the creative settings (highlighters, atmosphere, relief, lines, finish) as a small JSON file to back up or share.'));
    const b2 = el('div', 'btns');
    button(b2, 'Download look (.json)', () => {
      const s = JSON.parse(snapshot());
      download(new Blob([JSON.stringify({ name: app.project.name, app: 'Vathography Studio', settings: s }, null, 2)], { type: 'application/json' }), `${fileBase()}_look.json`).catch((e) => toast('Saving failed: ' + e.message, true));
    });
    button(b2, 'Import look…', () => $('lookInput').click());
    body.append(b2);
  }
  body.append(go);
}
function addDiskOption(body, px) {
  if (!window.showSaveFilePicker) {
    if (px > 150e6) body.append(el('p', 'hint', 'Very large file: Chrome or Edge can write it straight to disk with less memory.'));
    return;
  }
  if (px > 150e6 && !exp.toDisk) exp.toDisk = true;
  check(body, 'Write directly to disk (recommended for very large prints)', exp.toDisk, (v) => { exp.toDisk = v; saveExp(); });
}
async function doExport(w, h, format, dpi, name) {
  const ext = format.startsWith('tiff') ? 'tif' : format === 'jpeg' ? 'jpg' : 'png';
  const filename = `${name}.${ext}`;
  const ac = new AbortController();
  $('exportDlg').close();
  busy(`Rendering ${w.toLocaleString()} × ${h.toLocaleString()} px…`, 0, ac);
  const t0 = performance.now();
  try {
    await updateSignature(app.s.signature.size / 100 * h * 1.3);
    const blob = await exportImage(renderer, app.s, layout(), {
      w, h, format, dpi, filename, quality: format === 'jpeg' && w * h > 4e6 ? 0.96 : 0.95, signal: ac.signal,
      toDisk: exp.toDisk && !!window.showSaveFilePicker && format !== 'jpeg' && exp.tab !== 'social',
      text: { Software: 'Vathography Studio', Title: app.project.name, 'vathography:settings': snapshot() },
      onProgress: (p) => busy(`Rendering ${w.toLocaleString()} × ${h.toLocaleString()} px… ${Math.round(p * 100)}%`, p, ac),
    });
    if (blob) await download(blob, filename);
    toast(`Exported ${filename} (${w}×${h}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    if (e.name === 'AbortError') toast('Export cancelled');
    else { console.error(e); toast('Export failed: ' + e.message, true, 8000); }
  } finally {
    sigKey = '';
    updateSignature();
    idle();
  }
}
async function doVideo(w, h) {
  $('exportDlg').close();
  const ac = new AbortController();
  const c = $('gl'), wasPlaying = app.playing;
  app.playing = false;
  const prev = [c.width, c.height];
  app.recording = true;
  try {
    c.width = w; c.height = h;
    await updateSignature(app.s.signature.size / 100 * h * 1.3);
    busy('Recording video…', 0, ac);
    const blob = await recordVideo(renderer, app.s, layout(), app.s.anim, { w, h, fps: exp.fps, bitrate: w * h * exp.fps * 0.35, signal: ac.signal, onProgress: (p) => busy(`Recording video… ${Math.round(p * 100)}%`, p, ac) });
    await download(blob, `${fileBase()}_${w}x${h}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
    toast(blob.type.includes('mp4') ? 'Video saved (MP4)' : 'Video saved (WebM). Most platforms accept it; convert to MP4 if needed.');
  } catch (e) {
    if (e.name === 'AbortError') toast('Recording cancelled'); else { console.error(e); toast('Recording failed: ' + e.message, true); }
  } finally {
    app.recording = false;
    c.width = prev[0]; c.height = prev[1];
    sigKey = '';
    updateSignature();
    app.playing = wasPlaying;
    idle();
    resizeCanvas();
  }
}

// ---- depth processing changes -------------------------------------------------------------
let rrT;
function reRefine() {
  clearTimeout(rrT);
  rrT = setTimeout(async () => {
    try { await refineDepth(); } catch (e) { toast('Depth refinement failed: ' + e.message, true); }
    idle(); renderPanel(); scheduleSave();
  }, 250);
}

// ---- back button: Android back (and browser back) closes the top dialog, menu or sheet ---------
const layers = [];
let skipPop = 0;
function openLayer(close) { layers.push(close); history.pushState({ layer: layers.length }, ''); }
function closedLayer(close) { const i = layers.lastIndexOf(close); if (i < 0) return; layers.splice(i, 1); skipPop++; history.back(); }
window.addEventListener('popstate', () => { if (skipPop) { skipPop--; return; } layers.pop()?.(); });
// Android app: the hardware back button walks back through them, then leaves the app (App plugin)
if (window.Capacitor?.isNativePlatform?.()) window.Capacitor.addListener?.('App', 'backButton', () => { if (layers.length) history.back(); else window.Capacitor.nativePromise('App', 'minimizeApp').catch(() => {}); });
function showDialog(dlg) {
  dlg.showModal();
  const close = () => dlg.close();
  openLayer(close);
  dlg.addEventListener('close', () => closedLayer(close), { once: true });
}

// ---- phone layout: bottom sheet with tabs ---------------------------------------------------------
function updateSheet() {
  $('sheet').classList.toggle('closed', mobile && !ui.open);
  $('sheet').style.setProperty('--sheet-h', Math.round(ui.h * 100) + 'dvh');
  for (const b of $('tabbar').children) { b.classList.toggle('on', b.dataset.tab === ui.tab); b.classList.toggle('open', ui.open); }
}
let sheetLayer = null;
function setSheet(open) {
  ui.open = open; saveUi(); updateSheet();
  if (open && mobile && !sheetLayer) { sheetLayer = () => { sheetLayer = null; setSheet(false); }; openLayer(sheetLayer); }
  if (!open && sheetLayer) { const l = sheetLayer; sheetLayer = null; closedLayer(l); }
}
$('tabbar').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tab === ui.tab && ui.open) { setSheet(false); return; }
  const changed = b.dataset.tab !== ui.tab;
  ui.tab = b.dataset.tab;
  setSheet(true);
  if (changed) { renderPanel(); $('panel').scrollTop = 0; }
};
{
  // drag the handle to resize the sheet, flick it down to close, tap to toggle half / tall
  const hd = $('sheetHandle');
  let sd = null;
  hd.addEventListener('pointerdown', (e) => { hd.setPointerCapture(e.pointerId); sd = { y: e.clientY, h: ui.h, t: performance.now() }; $('sheet').classList.add('dragging'); });
  hd.addEventListener('pointermove', (e) => {
    if (!sd) return;
    ui.h = clamp(sd.h - (e.clientY - sd.y) / innerHeight, 0.12, 0.86);
    updateSheet();
  });
  const end = (e) => {
    if (!sd) return;
    $('sheet').classList.remove('dragging');
    const dy = e.clientY - sd.y;
    if (Math.abs(dy) < 6) ui.h = ui.h < 0.6 ? 0.74 : 0.42;
    else if (ui.h < 0.22 || (dy > 60 && performance.now() - sd.t < 250)) { ui.h = sd.h; setSheet(false); sd = null; return; }
    sd = null;
    saveUi(); updateSheet();
  };
  hd.addEventListener('pointerup', end);
  hd.addEventListener('pointercancel', end);
}
const mq = matchMedia('(max-width: 760px), (max-height: 520px) and (pointer: coarse)'), mqLand = matchMedia('(orientation: landscape)');
function applyMode() {
  const m = mq.matches, root = document.documentElement;
  root.classList.toggle('is-mobile', m);
  root.classList.toggle('land', m && mqLand.matches);
  if (m !== mobile) { mobile = m; renderPanel(); }
  updateSheet();
}
mq.addEventListener('change', applyMode);
mqLand.addEventListener('change', applyMode);

// ---- header menu (phones) ----------------------------------------------------------------------
const menu = $('menu');
let menuLayer = null;
function toggleMenu(open = menu.hidden) {
  menu.hidden = !open;
  $('btnMenu').setAttribute('aria-expanded', open);
  if (open) {
    for (const b of menu.querySelectorAll('[data-needs-photo]')) b.disabled = !app.photo;
    menuLayer = () => { menuLayer = null; toggleMenu(false); };
    openLayer(menuLayer);
  } else if (menuLayer) { const l = menuLayer; menuLayer = null; closedLayer(l); }
}
$('btnMenu').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('#menu, #btnMenu')) toggleMenu(false); });
menu.onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  toggleMenu(false);
  ({ open: () => $('fileInput').click(), gallery: openGallery, version: saveVersion, demo: openDemo, install: installApp })[b.dataset.act]?.();
};
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; menu.querySelector('[data-act=install]').hidden = false; });
async function installApp() {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => null);
  installEvt = null;
  menu.querySelector('[data-act=install]').hidden = true;
}

// ---- boot -------------------------------------------------------------------------------------
for (const id of ['btnExport', 'btnSnapshot']) $(id).disabled = true;
updateUndoButtons();
applyMode();
renderPanel();
renderRecent();
store.persist();
window.addEventListener('beforeunload', () => { if (app.project) saveProject(); });
// installable app and offline start (not inside the Android shell, which serves the files itself)
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !window.Capacitor) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker', e));
// photos opened with the installed app from the file manager
window.launchQueue?.setConsumer(async (p) => { const f = await p.files?.[0]?.getFile(); if (f) openPhotoFile(f); });
// test hook
window.__vath = { app, renderer, openDemo, openPhotoFile, exportImage: (o) => exportImage(renderer, app.s, layout(), o), layout, commit, onChange, renderPanel, importDepthMap };
