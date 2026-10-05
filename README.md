# Vathography Studio

A studio for **vathography**: artworks made from the *depth* of a photograph. An AI model estimates how far away every point of the scene is. You then choose which distances light up: a thin white band picks out one plane, several bands pick out several, and gradients turn distance into mist.

The practice was introduced by Karim Joseph Nassar ([vathography.com](https://vathography.com/), “Introducing Vathography: The Art of a Photograph’s Hidden Volume”). This studio is an independent tool for making your own work in that spirit.

## Use it

| | |
| --- | --- |
| **In the browser** | **[dasbutterschnitzel.github.io/vathography-studio](https://dasbutterschnitzel.github.io/vathography-studio/)**: open and start. Chrome and Edge offer *Install app* in the address bar (desktop) or the menu (Android), which adds it to the start menu or home screen and lets it start offline. On iPhone/iPad: *Share → Add to Home Screen*. |
| **Android app** | **[Vathography-Studio.apk](https://github.com/DasButterschnitzel/vathography-studio/releases/latest/download/Vathography-Studio.apk)**: download on the phone, open it and allow installing from this source once. Exports open the share sheet (Photos, Drive, Files…) and are also saved in *Documents/Vathography*. |
| **Windows app** | **[Installer](https://github.com/DasButterschnitzel/vathography-studio/releases/latest/download/Vathography-Studio-Setup.exe)** or **[portable .exe](https://github.com/DasButterschnitzel/vathography-studio/releases/latest/download/Vathography-Studio-Portable.exe)** (runs without installing). The app is not code-signed, so SmartScreen may warn: *More info → Run anyway*. |

All builds are on the **[Releases](https://github.com/DasButterschnitzel/vathography-studio/releases)** page. GitHub Actions makes them on every push to `main` (`.github/workflows/apps.yml`, release *latest*); a tag such as `v1.1.0` makes a versioned release. The web version is published by `.github/workflows/pages.yml`; enable it once under *Settings → Pages → Source: GitHub Actions*.

### Run it locally

It is a static web app with no build step and no server-side code. Serve this folder and open it in Chrome, Edge, Firefox or Safari:

```sh
python3 -m http.server 8080
# open http://localhost:8080
```

(Any static server works, for example `npx http-server .`. Opening `index.html` directly from disk does not work, because browsers block ES modules and workers on `file://`.)

### Build the apps yourself

The apps wrap the same files; nothing is changed for them.

- **Windows / macOS / Linux** (Electron, `apps/desktop`): `npm ci`, then `npm start` to run it, or `npm run dist:win` (also `dist:mac`, `dist:linux`). Output in `apps/desktop/dist/`.
- **Android** (Capacitor, `apps/android`, needs JDK 21 and the Android SDK): `npm ci`, `node prepare.mjs`, then `cd android && ./gradlew assembleRelease`. Output in `android/app/build/outputs/apk/release/`.

Android signing: without secrets, the APK is signed with the public test key `apps/android/test.keystore`. That is fine for your own phone, and new builds install over old ones, but anyone could sign an APK with that key. For a private key, create one (`keytool -genkeypair -keystore release.keystore -alias vathography -keyalg RSA -keysize 2048 -validity 36500`) and add the repository secrets `ANDROID_KEYSTORE_BASE64` (the file, base64-encoded), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Switching keys means uninstalling the old app once, which deletes its gallery, so export what you want to keep first.

Everything runs on your device. Photos and artworks are stored in your browser's (or the app's) local storage (IndexedDB) and are never uploaded. The only network requests are:

- the depth model, downloaded once from Hugging Face and then cached (27 MB for Small on CPU, about 100 MB on GPU);
- the AI runtime from jsDelivr;
- fonts from Google Fonts.

## Workflow

1. **Open a photo** (button, drag and drop, or paste). The depth model runs: WebGPU when available, otherwise WebAssembly. The depth is then snapped to the photo's edges at up to 4096 px. You can also start with **Try the demo scene**, which needs no download.
2. **Pick a look** to start from. Looks place their highlighters on the subjects detected in *your* photo.
3. **Shape the depth highlighters** (up to 8):
   - drag the bands in the **depth ruler** under the image (move the middle, resize at the edges, double-click to add);
   - or use **◎ Pick distance**: click the photo to move the selected highlighter to that distance, Shift+click to add a new one;
   - each highlighter has a style (*Solid*, *Photo* to reveal the original photograph, or *Line* for one crisp iso-distance line), width, softness, colour, intensity, photo texture, depth glow and blend mode (screen, add, normal, multiply/ink);
   - **Auto-place on subjects** finds people, boats and trees standing in front of their background; **Strata** makes 3, 5 or 8 evenly spaced planes.
4. **Atmosphere**: a near → mid → far gradient (mist, night fog, paper, sepia, cyanotype…), optionally mixed with the photo. Add **Relief** (the depth surface lit like a plaster cast), **Contour lines**, and **Finish** (exposure, contrast, vignette, film grain).
5. **Depth** controls: near/far clip, spread, invert, and *Clean edges*, which hides the thin halos around silhouettes (turn it down to keep them as an outline effect).
6. **Frame & crop**: aspect presets (Instagram 4:5, Story 9:16, A-paper, 3:2…), crop zoom, the ⬚ Crop tool to drag the composition, and a gallery mat border with extra space at the bottom. **Signature** signs the artwork in the border or on the image.
7. **Export** (Ctrl+E).

Every photo becomes an artwork in the **Gallery** and is saved automatically. **Save version** (Ctrl+S) branches a copy so you can make several artworks from one photo. **Save current as look** keeps your own looks; looks can be exported and imported as JSON.

## Export

| Tab | What you get |
| --- | --- |
| **Print** | A-sizes A4–A0, 30×40 to 100×150 cm, 8×10 to 40×60 in, at 150–360 dpi. PNG 16-bit, TIFF 16/8-bit, PNG 8-bit or JPEG, all tagged with the DPI. The dialog warns when the artwork and paper proportions differ, and can match the frame to the paper. |
| **Social** | Instagram 4:5 / 1:1 (1080 and 2160), Story/Reel/TikTok 9:16, X/LinkedIn, 4K and phone wallpapers. Choosing a format sets the frame so you can compose for it. |
| **Custom** | Any long edge up to 60 000 px. |
| **Video** | A depth sweep (a plane travelling through space), drift or breathe animation, as MP4 (Chrome/Edge/Safari) or WebM, up to 4K at 30/60 fps, for Reels, TikTok and Shorts. |
| **Depth & look** | The depth map as a 16-bit PNG (white = near), for Photoshop lens blur, Blender or After Effects, and the look as JSON. |

Large prints are rendered in tiles and streamed into the file, so an A0 print at 300 dpi (≈ 9900 × 14000 px, 140 MP) does not need a giant canvas. In Chrome and Edge, *Write directly to disk* streams the file to disk as it is written.

Every effect is defined in artwork units, not pixels, so a 1080 px post and a 14 000 px print show the same image. Bands, lines, gradients and grain are rendered natively at print resolution and stay crisp at any size. Photo texture inside the bands is upscaled with bicubic interpolation when the print needs more pixels than the photo has. The print tab reports the photo's native ppi for the chosen size.

## Best depth for big prints

The in-browser model is fast and good. For the finest depth on large prints, compute a full-resolution depth map with Marigold on a computer with a GPU:

```sh
pip install torch diffusers transformers accelerate pillow numpy
python tools/marigold_depth.py photo.jpg --ensemble 10 --res 1024
```

Then use **Depth ▸ Import depth map…** (or drop `photo_depth16.png` onto the studio). Depth maps from other tools work too: 8 or 16-bit PNG, white = near. If near and far come out swapped, use **Invert**.

## On a phone or tablet

On a phone the studio switches to a touch layout: the artwork on top, the depth ruler under it, and a bottom sheet with five tabs (**Looks**, **Bands**, **Style**, **Frame**, **Depth**). Tap the active tab to hide the sheet and see the artwork large; drag the sheet's handle to make it taller. Turn the phone sideways and the controls move to the right. The ☰ menu has Open photo, Gallery, Save as new version and the demo scene. The back button closes dialogs, the menu and the sheet.

| Gesture | Where | Action |
| --- | --- | --- |
| Pinch / drag | artwork | Zoom / pan |
| Double tap | artwork | Zoom in there, or back to fit |
| Tap / drag | artwork, ◎ pick tool | Move the selected band to that distance / scrub through distances |
| Long press | artwork, ◎ pick tool | Add a new band at that distance |
| Drag / pinch | artwork, ⬚ crop tool | Move / zoom the crop |
| Drag | depth ruler | Move the band nearest to your finger |
| Pinch | depth ruler | Change that band's width (a line's thickness) |
| Double tap | depth ruler, free space | Add a band there |

## Shortcuts

| Key | Action |
| --- | --- |
| `O` / `G` | Open photo / Gallery |
| `Ctrl+Z`, `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+S` / `Ctrl+E` | Save version / Export |
| `A` `\` `D` `C` | Artwork / photo / depth / split view |
| `H` `P` `F` | Pan, pick distance, crop tool |
| `0` / `1` | Fit / 1:1 zoom (mouse wheel or pinch zooms, drag pans) |
| `N` / `Delete` | Add / delete highlighter |
| `[` `]` (Shift for bigger steps) | Nudge the selected highlighter nearer / farther (preview focused) |
| `Space` | Play / stop the animation preview |

## Notes

- Needs WebGL2. AI depth needs WebAssembly (all current browsers) and uses WebGPU when present. HEIC photos must be converted to JPEG first in browsers that cannot decode HEIC.
- Code: `js/renderer.js` (WebGL engine), `js/depth.js` (AI depth), `js/refine.worker.js` (edge-aware upsampling), `js/codecs.js` (streaming PNG/TIFF), `js/export.js`, `js/app.js` (UI).
- Tests: `npm install && npm test` runs a headless-browser smoke test (demo scene, every look, every export format, undo/redo). CI runs it on every push and pull request.

Depth models: [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) via [transformers.js](https://github.com/huggingface/transformers.js), and [Marigold](https://marigoldmonodepth.github.io/) (optional, offline).
