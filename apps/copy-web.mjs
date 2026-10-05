#!/usr/bin/env node
// Copies the web app into a folder: GitHub Pages (_site) or a native shell's web folder.
// `node apps/copy-web.mjs <dest>`. Add new top-level runtime files to FILES.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['index.html', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'sw.js', 'icons', 'js'];
const dest = path.resolve(process.argv[2] || 'www');
fs.rmSync(dest, { recursive: true, force: true });
for (const f of FILES) fs.cpSync(path.join(ROOT, f), path.join(dest, f), { recursive: true });
console.log(`web app copied to ${dest}`);
