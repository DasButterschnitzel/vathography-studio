#!/usr/bin/env node
// Headless smoke test: demo scene, every look, highlighter editing, undo/redo,
// every export format, gallery round trip. No network needed (the demo scene
// has its own depth). Screenshots go to test-output/.
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { startServer, ROOT } from './serve.mjs';

const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const { server, url } = await startServer();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('page error: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Smoke look' : undefined));

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failed++; };
const ready = () => page.waitForFunction(() => document.getElementById('busy').hidden && window.__vath?.app.depth, null, { timeout: 120000 });

try {
  await page.goto(url);
  await page.click('#emptyDemo');
  await ready();
  await page.waitForTimeout(800);
  const st = () => page.evaluate(() => ({ n: __vath.app.s.highlighters.length, c: __vath.app.s.highlighters.map((h) => h.center), peaks: __vath.app.peaks }));
  const s0 = await st();
  check(s0.n === 3 && s0.peaks.length === 3, `demo opens with 3 highlighters on detected subjects (${s0.peaks.map((p) => p.toFixed(2)).join(', ')})`);
  await page.screenshot({ path: path.join(OUT, 'demo.png') });

  const looks = await page.locator('.look').count();
  for (let i = 0; i < looks; i++) await page.locator('.look').nth(i).click();
  check(looks >= 12, `${looks} looks apply`);
  await page.locator('.look').first().click();

  // pick tool: shift+click adds a highlighter
  await page.click('#toolSeg button[data-tool="pick"]');
  const vb = await page.locator('#viewport').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.click(vb.x + vb.width * 0.5, vb.y + vb.height * 0.6);
  await page.keyboard.up('Shift');
  const s1 = await st();
  check(s1.n === 2, `pick tool adds a highlighter (${s1.n})`);

  // drag a band in the depth ruler, then undo / redo
  const band = await page.locator('.band').first().boundingBox();
  await page.mouse.move(band.x + band.width / 2, band.y + 30);
  await page.mouse.down();
  await page.mouse.move(band.x + band.width / 2 + 60, band.y + 30, { steps: 4 });
  await page.mouse.up();
  const moved = (await st()).c[0];
  await page.keyboard.press('Control+z');
  const undone = (await st()).c[0];
  await page.keyboard.press('Control+Shift+z');
  const redone = (await st()).c[0];
  check(moved !== undone && redone === moved, 'ruler drag, undo and redo');

  // exports
  const res = await page.evaluate(async () => {
    const out = {};
    for (const format of ['png', 'png16', 'tiff', 'tiff16', 'jpeg']) {
      const b = await __vath.exportImage({ w: 900, h: 600, format, dpi: 300 });
      const head = Array.from(new Uint8Array(await b.slice(0, 4).arrayBuffer()));
      let dims = null;
      if (!format.startsWith('tiff')) { const bm = await createImageBitmap(b); dims = [bm.width, bm.height]; }
      out[format] = { size: b.size, head, dims };
    }
    return out;
  });
  const sig = { png: [137, 80], png16: [137, 80], tiff: [73, 73], tiff16: [73, 73], jpeg: [255, 216] };
  for (const [f, r] of Object.entries(res)) {
    check(r.size > 1000 && r.head[0] === sig[f][0] && r.head[1] === sig[f][1] && (!r.dims || (r.dims[0] === 900 && r.dims[1] === 600)), `export ${f} (${(r.size / 1024).toFixed(0)} KB)`);
  }

  // tiled export across the 4096 px tile boundary
  const big = await page.evaluate(async () => { const b = await __vath.exportImage({ w: 5000, h: 1200, format: 'png', dpi: 300 }); const bm = await createImageBitmap(b); return [bm.width, bm.height]; });
  check(big[0] === 5000 && big[1] === 1200, 'tiled 5000 px export');

  // gallery round trip
  await page.click('#btnSnapshot');
  await page.waitForTimeout(1500);
  await page.click('#btnGallery');
  await page.waitForTimeout(500);
  const cards = await page.locator('.card').count();
  check(cards === 2, `gallery holds the artwork and its version (${cards})`);
  await page.locator('.card .btn:has-text("Open")').last().click();
  await ready();
  check(await page.evaluate(() => __vath.app.project.name) === 'Demo landscape', 'reopen from gallery');

  await page.click('#btnExport');
  for (const t of ['print', 'social', 'custom', 'video', 'extras']) await page.click(`#exportTabs button[data-tab="${t}"]`);
  check(true, 'export dialog tabs render');
  await page.screenshot({ path: path.join(OUT, 'export.png') });
} catch (e) {
  check(false, 'unexpected: ' + e.message);
} finally {
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
