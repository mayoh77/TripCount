// TripCount Service Worker v3
// IMPORTANT: Never intercept Firebase or external API requests
const CACHE = 'tripcount-v3';
const STATIC = ['./','./index.html','./style.css','./app.js','./manifest.json'];

const BYPASS_DOMAINS = [
  'firebasestorage.googleapis.com',
  'firestore.googleapis.com',
  'googleapis.com',
  'gstatic.com',
  'photon.komoot.io',
  'fonts.googleapis.com',
  'unpkg.com',
  'cartocdn.com',
  'openstreetmap.org',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Bypass: non-GET, external APIs, Firebase - let browser handle with full CORS
  if (
    e.request.method !== 'GET' ||
    BYPASS_DOMAINS.some(d => url.includes(d)) ||
    !url.startsWith('https://mayoh77.github.io')
  ) {
    return; // Don't call respondWith - browser handles natively
  }

  // Cache-first only for our own GitHub Pages assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
