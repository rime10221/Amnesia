const VERSION = 'amnesia-v6';
const SHELL = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === location.origin;
  const isCdn = url.hostname === 'cdnjs.cloudflare.com';
  if (!sameOrigin && !isCdn) return; // Google APIs etc. go straight to the network
  const put = res => { if (res && res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; };
  if (sameOrigin && !url.pathname.includes('/icons/')) {
    // app shell: network-first so updates show up immediately, cache fallback when offline
    e.respondWith(fetch(e.request).then(put).catch(() => caches.match(e.request).then(c => c || caches.match('./index.html'))));
  } else {
    // libraries & icons: cache-first
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(put)));
  }
});
