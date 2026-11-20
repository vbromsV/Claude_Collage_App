// Service worker: keeps the app shell available offline.
// Bump VERSION whenever app files change so phones pick up the new version.
const VERSION = 'collage-v1.3.0';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/gif.js',
  './lib/gifenc.esm.js',
  './lib/omggif.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: answer from cache immediately (works offline),
// and refresh the cache in the background when online.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const isNav = req.mode === 'navigate';
    const cached = await cache.match(isNav ? './index.html' : req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        cache.put(isNav ? './index.html' : req, res.clone());
      }
      return res;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    const res = await network;
    if (res) return res;
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  })());
});
