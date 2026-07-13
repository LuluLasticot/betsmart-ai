/* BetSmart AI — Service Worker
   Stratégie : cache-first pour le shell, network-first pour les CDN. */
const CACHE = 'betsmart-v43';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/firebase-config.js',
  './js/cloud.js',
  './js/stats.js',
  './js/analytics.js',
  './js/gemini.js',
  './js/settle.js',
  './js/live.js',
  './js/odds.js',
  './js/coteur.js',
  './js/facts.js',
  './js/advisor.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Ne jamais intercepter les API externes (Gemini, Firebase, cotes, proxies CORS)
  // ni notre backend serverless /api/ (données temps réel)
  const bypass = ['googleapis.com', 'firebaseapp.com', 'the-odds-api.com', 'coteur.com', 'allorigins.win', 'corsproxy.io', 'thingproxy.freeboard.io'];
  if (bypass.some((h) => url.hostname.endsWith(h)) || url.pathname.startsWith('/api/') || e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        // Met en cache les ressources same-origin et polices
        if (res.ok && (url.origin === location.origin || url.hostname.includes('fonts.g'))) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
