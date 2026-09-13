/* DFinance service worker — cache-first app shell, works offline after the first load. */
const VERSION = 'dfinance-v3';
const SHELL = VERSION + '-shell';
const RUNTIME = VERSION + '-runtime';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './favicon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
];

// Cached the first time they are used, so fonts and the spreadsheet library
// keep working offline afterwards.
const RUNTIME_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Add one by one so a single missing file can't fail the whole install.
    await Promise.all(SHELL_FILES.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone()).catch(() => {});
    return response;
  }).catch(() => null);
  if (cached) return cached;
  const fresh = await network;
  if (fresh) return fresh;
  throw new Error('offline');
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Page loads: cache-first on the shell, so the app opens with no connection.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = (await cache.match('./index.html')) || (await cache.match('./'));
      if (cached) {
        event.waitUntil(fetch(request).then(res => {
          if (res && res.ok) cache.put('./index.html', res.clone());
        }).catch(() => {}));
        return cached;
      }
      try { return await fetch(request); }
      catch (e) { return new Response('<h1>DFinance is offline</h1><p>Open it once with a connection, then it works offline.</p>', { headers: { 'Content-Type': 'text/html' }, status: 503 }); }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL).catch(() => fetch(request)));
    return;
  }

  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME).catch(() => Response.error()));
  }
});
