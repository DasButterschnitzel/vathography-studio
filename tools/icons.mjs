#!/usr/bin/env node
// Renders the PNG icons from the artwork of icon.svg: web app manifest icons
// (icons/) and the Android launcher icons and splash screens (apps/android/res/).
// Run after changing the icon: `node tools/icons.mjs`. The PNGs are committed.
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { ROOT } from './serve.mjs';

const BG = '#0b0b0c';
const ARCS = '<path d="M8 44c10-6 18-8 24-8s14 2 24 8" fill="none" stroke="#3a3a3e" stroke-width="3"/><path d="M8 34c10-6 18-8 24-8s14 2 24 8" fill="none" stroke="#f3efe6" stroke-width="3.5"/><path d="M8 24c10-6 18-8 24-8s14 2 24 8" fill="none" stroke="#5a5a5f" stroke-width="3"/>';

// shape: rounded (like icon.svg), square (full bleed), circle, none (transparent);
// scale: size of the arcs relative to icon.svg, around the centre.
function svg(w, h, { shape = 'rounded', scale = 1 } = {}) {
  const s = Math.min(w, h) / 64;
  const bg = shape === 'rounded' ? `<rect width="64" height="64" rx="14" fill="${BG}"/>`
    : shape === 'circle' ? `<circle cx="32" cy="32" r="32" fill="${BG}"/>`
    : shape === 'square' ? `<rect x="-1000" y="-1000" width="3000" height="3000" fill="${BG}"/>` : '';
  const arcs = `<g transform="translate(32 32) scale(${scale}) translate(-32 -30)">${ARCS}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" style="display:block"><g transform="translate(${(w - 64 * s) / 2} ${(h - 64 * s) / 2}) scale(${s})">${bg}${arcs}</g></svg>`;
}

const jobs = [
  ['icons/icon-192.png', 192, 192, {}],
  ['icons/icon-512.png', 512, 512, {}],
  ['icons/maskable-512.png', 512, 512, { shape: 'square', scale: 0.72 }],
  ['icons/apple-touch-icon.png', 180, 180, { shape: 'square', scale: 0.85 }],
];
const DPI = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DPI)) {
  jobs.push([`apps/android/res/mipmap-${d}/ic_launcher.png`, 48 * k, 48 * k, {}]);
  jobs.push([`apps/android/res/mipmap-${d}/ic_launcher_round.png`, 48 * k, 48 * k, { shape: 'circle', scale: 0.78 }]);
  jobs.push([`apps/android/res/mipmap-${d}/ic_launcher_foreground.png`, 108 * k, 108 * k, { shape: 'none', scale: 0.55 }]);
  const [a, b] = [320 * k, 480 * k];
  jobs.push([`apps/android/res/drawable-port-${d}/splash.png`, a, b, { shape: 'square', scale: 0.4 }]);
  jobs.push([`apps/android/res/drawable-land-${d}/splash.png`, b, a, { shape: 'square', scale: 0.4 }]);
}
jobs.push(['apps/android/res/drawable/splash.png', 480, 320, { shape: 'square', scale: 0.4 }]);

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, w, h, o] of jobs) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0;background:transparent">${svg(w, h, o)}</body>`);
  const out = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.locator('svg').screenshot({ path: out, omitBackground: true });
  console.log(file, `${w}×${h}`);
}
await browser.close();
