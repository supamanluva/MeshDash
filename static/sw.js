// MeshDash service worker — caches the app shell for offline/installable use.
// Live data (/api/*) and cross-origin CDN requests always go to the network.
const CACHE = 'meshdash-v1';
const SHELL = ['/', '/static/style.css', '/static/app.js', '/static/manifest.webmanifest', '/static/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // CDN / non-GET → network
  if (u.pathname.startsWith('/api/')) return;                               // live data → network
  if (e.request.mode === 'navigate') {                                      // page → fresh, fall back to cache
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(                                                            // static → cache-first
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (resp.ok) { const c = resp.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); }
      return resp;
    }))
  );
});
