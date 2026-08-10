/* BetSmart AI — Service Worker
   Stratégie : cache-first pour le shell, network-first pour les CDN. */
const CACHE = 'betsmart-v91';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/firebase-config.js',
  './js/cloud.js',
  './js/money.js',
  './js/stats.js',
  './js/analytics.js',
  './js/gemini.js',
  './js/settle.js',
  './js/scores.js',
  './js/odds.js',
  './js/coteur.js',
  './js/poisson.js',
  './js/clubelo.js',
  './js/mlb.js',
  './js/anchor.js',
  './js/facts.js',
  './js/tennis.js',
  './data/tennis-elo.json',
  './data/basket-ratings.json',
  './data/mlb-ratings.json',
  './data/wnba-ratings.json',
  './data/football-elo-extra.json',
  './data/court-speed.json',
  './data/club-elo.json',
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
  // addAll() échoue EN BLOC dès qu'une seule ressource renvoie 404 : une table
  // de données pas encore générée casserait alors toute l'installation du
  // service worker, donc l'app hors ligne. On met donc en cache une ressource
  // à la fois, en tolérant les absences.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((url) => c.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
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
  const bypass = ['googleapis.com', 'firebaseapp.com', 'the-odds-api.com', 'coteur.com', 'allorigins.win', 'corsproxy.io', 'thingproxy.freeboard.io', 'api.github.com', 'githubusercontent.com'];
  if (bypass.some((h) => url.hostname.endsWith(h)) || url.pathname.startsWith('/api/') || e.request.method !== 'GET') return;

  // Données rafraîchies régulièrement (ex. Elo tennis) → network-first, cache en secours hors-ligne
  if (url.origin === location.origin && url.pathname.startsWith('/data/')) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, clone)); }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

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
