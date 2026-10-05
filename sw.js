// Service worker: makes the studio installable and lets it start offline.
// The app's own files are network-first (an update shows on the next reload),
// pinned CDN files (AI runtime, fonts) cache-first. The depth model is cached by
// transformers.js itself, so Hugging Face requests pass through untouched.
const CACHE = 'vath-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'js/app.js', 'js/renderer.js', 'js/state.js', 'js/layout.js', 'js/depth.js', 'js/refine.worker.js', 'js/analysis.js', 'js/codecs.js', 'js/export.js', 'js/store.js', 'js/demo.js'];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('vath-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) e.respondWith(networkFirst(req));
  else if (CDN.test(req.url)) e.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('index.html'));
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
