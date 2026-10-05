# Vathography Studio

A browser tool for photographers that turns a photo into a *vathograph*: an artwork drawn from the scene's estimated depth, with up to 8 "depth highlighters" (bands at chosen distances), atmosphere gradients, relief, contour lines, print-size exports and depth-sweep videos. The user-facing documentation is in `README.md`.

## Ground rules

- **Static site, no build step, no framework.** Plain ES modules, HTML and CSS. Do not add bundlers, TypeScript or UI libraries. The Android and desktop apps in `apps/` only wrap the same files; keep app-specific code tiny and feature-detected (`window.Capacitor`).
- **No `prompt()`**: Electron does not support it; use `askText()` in `app.js`. `confirm()` is fine.
- **The only runtime dependency** is transformers.js, imported from jsDelivr with a pinned version in `js/depth.js`. Fonts come from Google Fonts. Everything else is in this repo.
- **Everything stays on the user's device.** No analytics, no uploads, no backend. Projects live in IndexedDB.
- The UI text is English; the owner may write to you in German.
- Keep the code style of the surrounding file: compact, few comments explaining *why*, 2-space indent, single quotes.

## Layout

| File | Role |
| --- | --- |
| `index.html`, `styles.css` | Page shell and all styling (dark theme, CSS variables on `:root`, mobile layout under 900 px). |
| `js/app.js` | Application shell: state, viewport (pan, zoom, pick, crop), depth ruler, side panel (built in `renderPanel()`), undo/redo, autosave, gallery, export dialog. |
| `js/renderer.js` | WebGL2 engine: one fragment shader renders the preview, thumbnails, video frames and print tiles. `renderRegion()` renders any pixel rectangle of an output image. |
| `js/state.js` | Settings schema (`defaultSettings()`), `newHighlighter()`, `normalize()` (merges over defaults and upgrades old saves), built-in `LOOKS`, `applyLook()`. |
| `js/layout.js` | Artwork geometry: aspect, crop, border and signature placement (`computeLayout()`). |
| `js/depth.js` | AI depth (Depth Anything V2 via transformers.js, WebGPU → WASM fallback), optional two-resolution fusion, disparity normalisation. |
| `js/refine.worker.js` | Edge-aware upsampling: a colour guided filter at about 1–1.4K, then joint bilateral upsampling to full resolution. |
| `js/analysis.js` | Depth histogram and the subject finder (`subjectPeaks()`). |
| `js/codecs.js` | Streaming PNG writer (8/16-bit with pHYs DPI and iTXt), TIFF writer, 16-bit PNG reader, depth-map PNG. |
| `js/export.js` | Tiled export pipeline, print and social presets, animation (`animState()`), MediaRecorder video. |
| `js/store.js` | IndexedDB stores: `projects` (metadata, settings, thumbnail), `assets` (`<id>:photo`, `<id>:raw` as a 16-bit PNG), `looks`. |
| `js/demo.js` | Procedural demo landscape with an exact depth map, so the app works without a photo or the model download. |
| `tools/smoke.mjs`, `tools/serve.mjs` | Headless Playwright smoke test and a tiny static server. |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installable web app: manifest, service worker (own files network-first, CDN cache-first, Hugging Face untouched), PNG icons rendered by `tools/icons.mjs`. |
| `apps/copy-web.mjs` | Copies the runtime files (its `FILES` list) into `_site` for Pages or `www/` for the native shells. |
| `apps/desktop/` | Electron shell for Windows/macOS/Linux: `main.cjs` serves the files from an `app://` origin. Built with electron-builder. |
| `apps/android/` | Capacitor shell for Android. `prepare.mjs` generates `android/` (not committed) and applies icons (`res/`), version and signing. Exports go through `saveNative()` in `export.js` (Filesystem + Share plugins via `Capacitor.nativePromise`, no bundler). |
| `tools/marigold_depth.py` | Offline full-resolution depth with Marigold, for large prints. Output is a 16-bit PNG, white = near. |

## Key conventions

- **Depth convention:** inside the app, depth is a `Float32Array` with **0 = nearest, 1 = farthest**. Imported maps follow the common white = near convention and are inverted on import. The depth-map export writes white = near again.
- **Remap:** `depth.near/far/gamma/invert` turn raw depth into the "distance" `d` that every effect and the ruler use. The JS `remap()` in `app.js` and `remap()` in the shader must stay identical.
- **Artwork units:** the artwork is 1 unit tall and `layout.artW` wide. The shader maps every framebuffer pixel to artwork units (`uOrigin + fragCoord * uPx`). Line thickness (per mille of the height), grain size, signature size and borders are all defined in artwork units, so a 1080 px post, the preview and a 14 000 px print look the same. Never define an effect in output pixels.
- **Shader rules:** compute anything that uses derivatives (`fwidth`, implicit-LOD `texture()`) in uniform control flow, before branching. Highlighters are packed into `uHlA..uHlD[MAX_HL]` vec4 arrays; adding a highlighter property means adding it to `newHighlighter()`, the packing in `Renderer.#draw()` and the shader.
- **Settings changes:** new settings get a default in `defaultSettings()` (or `newHighlighter()`), so `normalize()` upgrades old projects automatically. Controls call `onChange(kind)` while dragging and `commit()` when done (undo snapshot and autosave).
- **Exports** go through `stripSource()`: strips of rows, tiles at most `renderer.maxRB` (4096) wide, `readPixels` (flipped to top-down), and streamed into the encoder. Do not build full-size canvases except for JPEG.
- **Test hook:** `window.__vath` exposes `app`, `renderer`, `layout()`, `exportImage()`, `openDemo()`, `commit()` and more, for tests and debugging.

## Run and test

```sh
npm install            # only Playwright, for tests
npm run serve          # http://127.0.0.1:8080 (or: python3 -m http.server 8080)
npm test               # headless smoke test, screenshots in test-output/
```

- The smoke test needs no network: it uses the demo scene. It covers looks, the pick tool, ruler drag, undo/redo, every export format, a tiled 5000 px export, the gallery round trip and the export dialog. Keep it passing, and extend it when you add features.
- In Claude Code cloud sessions Chromium is pre-installed: run tests with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm test` and never run `playwright install`.
- The AI depth path downloads a model from Hugging Face. To check it, open a real photo (for example with `page.setInputFiles('#fileInput', …)`); on WASM the first run downloads about 27 MB.
- Check visual changes with screenshots (Playwright) before calling them done.

## CI and deploy

- `.github/workflows/test.yml` runs `npm test` on every push and pull request and uploads the screenshots.
- `.github/workflows/pages.yml` publishes the files listed in `apps/copy-web.mjs` to GitHub Pages on pushes to `main`. Pages must be enabled once under *Settings → Pages → Source: GitHub Actions*. If you add a top-level runtime file, add it to `FILES` in `apps/copy-web.mjs` (and to `SHELL` in `sw.js` if it is needed offline).
- `.github/workflows/apps.yml` builds the Android APK (Capacitor) and the Windows installer and portable exe (Electron) on every push and pull request. Pushes to `main` replace the release `latest`; tags `v*` make a versioned release. Asset names are stable, so `releases/latest/download/<name>` links keep working.
- Run the icon script after changing the icon: `node tools/icons.mjs`.

## Ideas not built yet

Features to consider next: an iOS build, a brush to paint depth corrections, HEIC import, a batch export of several sizes in one go, a print-preview mode with paper texture, a gallery backup as a zip file, and an ICC profile in exports.
