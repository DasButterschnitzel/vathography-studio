#!/usr/bin/env node
// Phone smoke test (Pixel 7, touch): bottom sheet and tabs, back button, and the
// touch gestures (tap and long-press to pick, pinch zoom, double tap, ruler drag
// and pinch). Touches are sent through CDP so multi-touch works. Screenshots go
// to test-output/mobile-*.png.
import fs from 'fs';
import path from 'path';
import { chromium, devices } from 'playwright';
import { startServer, ROOT } from './serve.mjs';

const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const { server, url } = await startServer();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
if (process.env.SLOW) await cdp.send('Emulation.setCPUThrottlingRate', { rate: +process.env.SLOW });
const errors = [];
page.on('pageerror', (e) => errors.push('page error: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failed++; };
const ready = () => page.waitForFunction(() => document.getElementById('busy').hidden && window.__vath?.app.depth, null, { timeout: 120000 });
const wait = (ms) => page.waitForTimeout(ms);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
async function gesture(from, to, steps = 8, hold = 0) {
  await touch('touchStart', from);
  if (hold) await wait(hold);
  for (let i = 1; i <= steps; i++) await touch('touchMove', from.map(([x, y], k) => [x + (to[k][0] - x) * i / steps, y + (to[k][1] - y) * i / steps]));
  await touch('touchEnd', []);
}
const tapAt = async (x, y, hold = 0) => { await touch('touchStart', [[x, y]]); await wait(hold || 40); await touch('touchEnd', []); };
// double tap with fixed event timestamps, so a slow CI renderer cannot stretch the gap between the taps
async function doubleTap(x, y) {
  const t = Date.now() / 1000;
  for (const [type, dt] of [['touchStart', 0], ['touchEnd', 0.05], ['touchStart', 0.15], ['touchEnd', 0.2]]) await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 0 }], timestamp: t + dt });
}
const S = () => page.evaluate(() => ({ hl: __vath.app.s.highlighters.map((h) => ({ c: h.center, w: h.width })), sel: __vath.app.sel, scale: __vath.app.view.scale, fitted: __vath.app.view.fitted, open: !document.getElementById('sheet').classList.contains('closed'), mobile: document.documentElement.classList.contains('is-mobile') }));

try {
  await page.goto(url);
  check(await page.locator('.tabbar').isHidden(), 'welcome screen without controls');
  await page.tap('#emptyDemo');
  await ready();
  await wait(800);
  let s = await S();
  check(s.mobile && s.open && await page.locator('#tabbar [data-tab=looks].on').count() === 1, 'phone layout opens with the looks sheet');
  await page.screenshot({ path: path.join(OUT, 'mobile-looks.png') });

  // tabs
  await page.tap('#tabbar [data-tab=bands]');
  check(await page.locator('.hl').count() === 3 && await page.locator('.look').count() === 0, 'bands tab shows only the highlighters');
  await page.screenshot({ path: path.join(OUT, 'mobile-bands.png') });
  await page.tap('#tabbar [data-tab=bands]');
  await wait(400);
  check(!(await S()).open, 'tapping the active tab closes the sheet');
  await page.tap('#tabbar [data-tab=style]');
  await wait(400);
  check((await S()).open, 'another tab opens it again');
  await page.goBack();
  await wait(400);
  check(!(await S()).open, 'back button closes the sheet');

  // pick tool: tap moves the selected band, long press adds one
  const vb = await page.locator('#viewport').boundingBox();
  await page.tap('#toolSeg [data-tool=pick]');
  s = await S();
  await tapAt(vb.x + vb.width * 0.5, vb.y + vb.height * 0.62);
  await wait(200);
  let s2 = await S();
  check(s2.hl.length === 3 && s2.hl.some((h, i) => h.c !== s.hl[i].c), 'tap with the pick tool moves the selected band');
  await tapAt(vb.x + vb.width * 0.3, vb.y + vb.height * 0.4, 750);
  await wait(200);
  check((await S()).hl.length === 4, 'long press adds a band');

  // pinch zoom and double tap
  await page.tap('#toolSeg [data-tool=hand]');
  await page.tap('#zoomFit');
  s = await S();
  const cx = vb.x + vb.width / 2, cy = vb.y + vb.height / 2;
  await gesture([[cx - 40, cy], [cx + 40, cy]], [[cx - 120, cy], [cx + 120, cy]]);
  await wait(200);
  s2 = await S();
  check(s2.scale > s.scale * 2 && !s2.fitted, `pinch zooms (${(s2.scale / s.scale).toFixed(1)}×)`);
  await doubleTap(cx, cy);
  await wait(200);
  check((await S()).fitted, 'double tap fits again');

  // ruler: drag the nearest band, pinch its width, double tap to add
  const rb = await page.locator('#rulerBody').boundingBox();
  s = await S();
  const h0 = s.hl.find((h) => h.c > 0.3 && h.c < 0.7) || s.hl[0];
  const bx = rb.x + rb.width * h0.c + 10, by = rb.y + rb.height / 2;
  await gesture([[bx, by]], [[bx + 40, by]]);
  await wait(200);
  s2 = await S();
  const moved = s2.hl.find((h) => Math.abs(h.c - (h0.c + 40 / rb.width)) < 0.02);
  check(!!moved, 'touch drag moves a band in the ruler (finger next to it)');
  const mx = rb.x + rb.width * moved.c;
  await touch('touchStart', [[mx, by]]);
  await touch('touchStart', [[mx, by], [mx + 30, by]]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [[mx, by], [mx + 30 + i * 15, by]]);
  await touch('touchEnd', []);
  await wait(200);
  const s3 = await S();
  const w1 = Math.max(...s3.hl.map((h) => h.w));
  check(w1 > moved.w * 1.8, `pinch on the ruler widens the band (${moved.w.toFixed(3)} → ${w1.toFixed(3)})`);
  const n0 = s3.hl.length;
  // the free spot farthest from every band
  let free = 0.5, gap = 0;
  for (let t = 0.02; t < 0.98; t += 0.01) { const g = Math.min(...s3.hl.map((h) => Math.abs(h.c - t))); if (g > gap) { gap = g; free = t; } }
  const ex = rb.x + rb.width * free;
  await doubleTap(ex, by);
  await wait(200);
  check((await S()).hl.length === n0 + 1, 'double tap on the ruler adds a band');

  // sheet handle: drag up makes it taller
  await page.tap('#tabbar [data-tab=looks]');
  await wait(400);
  const hb = await page.locator('#sheetHandle').boundingBox();
  const h1 = (await page.locator('#sheet').boundingBox()).height;
  await gesture([[hb.x + hb.width / 2, hb.y + 10]], [[hb.x + hb.width / 2, hb.y - 200]], 10);
  await wait(400);
  check((await page.locator('#sheet').boundingBox()).height > h1 + 120, 'dragging the handle resizes the sheet');

  // full-screen export dialog, closed by the back button
  await page.tap('#btnExport');
  await wait(300);
  const db = await page.locator('#exportDlg').boundingBox();
  check(db.width >= 410 && db.height > 800, 'export dialog is full screen');
  await page.screenshot({ path: path.join(OUT, 'mobile-export.png') });
  await page.goBack();
  await wait(300);
  check(!(await page.evaluate(() => document.getElementById('exportDlg').open)), 'back button closes the export dialog');

  // landscape: controls move to the right
  await page.setViewportSize({ width: 915, height: 412 });
  await wait(600);
  const sb = await page.locator('#sheet').boundingBox(), tb = await page.locator('#tabbar').boundingBox();
  check(sb.x > 400 && tb.x > sb.x, 'landscape puts the sheet and tabs on the right');
  await page.screenshot({ path: path.join(OUT, 'mobile-landscape.png') });
} catch (e) {
  check(false, 'unexpected: ' + e.message);
} finally {
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
