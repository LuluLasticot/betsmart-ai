/* ==========================================================================
   BetSmart AI — Modèle Elo tennis (calcul CÔTÉ CLIENT)
   Les IP datacenter (Vercel) sont bloquées par GitHub, mais le navigateur de
   l'utilisateur (IP résidentielle) accède librement aux CSV Sackmann (CORS *).
   On télécharge donc les matchs ATP+WTA (2 saisons), on calcule un Elo par
   surface, et on met en cache 24 h dans IndexedDB. Couvre l'angle mort tennis.
   ========================================================================== */
'use strict';

const TennisElo = (() => {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3);

  const srcs = (repo, file) => [
    `https://raw.githubusercontent.com/JeffSackmann/${repo}/master/${file}`,
    `https://cdn.jsdelivr.net/gh/JeffSackmann/${repo}@master/${file}`
  ];
  async function fetchText(urls) {
    for (const u of urls) {
      try {
        const r = await fetch(u, { cache: 'force-cache' });
        if (!r.ok) continue;
        const t = await r.text();
        if (t && t.length > 200) return t;
      } catch (_) { /* url suivante */ }
    }
    return null;
  }

  const K = (n) => 250 / Math.pow(n + 5, 0.4);
  const surfKey = (s) => { const t = (s || '').toLowerCase(); return t.startsWith('clay') ? 'C' : t.startsWith('grass') ? 'G' : 'H'; };

  let building = null; // promesse de calcul en cours (évite les doublons)

  async function computeRatings() {
    const Y = new Date().getFullYear();
    const years = [Y - 1, Y - 2];
    const jobs = [];
    years.forEach((y) => {
      jobs.push(fetchText(srcs('tennis_atp', `atp_matches_${y}.csv`)));
      jobs.push(fetchText(srcs('tennis_wta', `wta_matches_${y}.csv`)));
    });
    const texts = await Promise.all(jobs);

    const rows = [];
    texts.forEach((txt) => {
      if (!txt) return;
      const lines = txt.split('\n');
      const head = lines[0].split(',');
      const iS = head.indexOf('surface'), iD = head.indexOf('tourney_date');
      const iW = head.indexOf('winner_name'), iL = head.indexOf('loser_name');
      if (iW < 0 || iL < 0) return;
      for (let k = 1; k < lines.length; k++) {
        const c = lines[k].split(',');
        if (c.length < head.length) continue;
        if (!c[iW] || !c[iL]) continue;
        rows.push({ w: c[iW], l: c[iL], s: surfKey(c[iS]), d: parseInt(c[iD], 10) || 0 });
      }
    });
    if (!rows.length) return null;
    rows.sort((a, b) => a.d - b.d);

    const R = {};
    const get = (n) => R[n] || (R[n] = { all: 1500, H: 1500, C: 1500, G: 1500, n: 0, nH: 0, nC: 0, nG: 0, last: 0 });
    for (const m of rows) {
      const W = get(m.w), L = get(m.l), sk = m.s;
      const eW = 1 / (1 + Math.pow(10, (L.all - W.all) / 400));
      W.all += K(W.n) * (1 - eW); L.all -= K(L.n) * (1 - eW);
      const eWs = 1 / (1 + Math.pow(10, (L[sk] - W[sk]) / 400));
      W[sk] += K(W['n' + sk]) * (1 - eWs); L[sk] -= K(L['n' + sk]) * (1 - eWs);
      W.n++; L.n++; W['n' + sk]++; L['n' + sk]++;
      W.last = Math.max(W.last, m.d); L.last = Math.max(L.last, m.d);
    }
    const cutoff = (new Date().getFullYear() - 1) * 10000;
    const players = {};
    for (const [name, r] of Object.entries(R)) {
      if (r.last < cutoff || r.n < 5) continue;
      players[norm(name)] = { e: Math.round(r.all), h: Math.round(r.H), c: Math.round(r.C), g: Math.round(r.G), n: r.n };
    }
    return Object.keys(players).length ? players : null;
  }

  async function ratings() {
    // Cache IndexedDB (24 h)
    try {
      const cached = await DB.getSetting('tennisEloCache');
      if (cached && cached.players && Date.now() - cached.at < 24 * 3600e3) return cached.players;
    } catch (_) {}
    if (!building) {
      building = (async () => {
        const players = await computeRatings();
        if (players) { try { await DB.setSetting('tennisEloCache', { at: Date.now(), players }, { silent: true }); } catch (_) {} }
        building = null;
        return players;
      })();
    }
    return building;
  }

  const SURF_LABEL = { h: 'dur', c: 'terre battue', g: 'gazon' };
  function detectSurface(comp) {
    const n = norm(comp);
    if (/wimbledon|halle|queens|eastbourne|mallorca|stuttgart|hertogenbosch|newport/.test(n)) return 'g';
    if (/roland|french open|gstaad|umag|bastad|kitzbuhel|hamburg|monte carlo|madrid|rome|barcelona|munich|estoril|bucharest|geneva|houston|marrakech|cordoba|santiago|buenos aires|rio de|sao paulo|bogota/.test(n)) return 'c';
    return 'h';
  }
  function findPlayer(name, players) {
    const q = norm(name);
    if (players[q]) return { r: players[q] };
    const qt = toks(name);
    let best = null, score = 0;
    for (const key in players) {
      const kt = key.split(' ');
      const overlap = qt.filter((t) => kt.includes(t)).length;
      const strong = qt.some((t) => t.length >= 5 && kt.includes(t));
      if (overlap > score && strong) { score = overlap; best = key; }
    }
    return best ? { r: players[best] } : null;
  }
  const surfRating = (r, surf) => 0.6 * (surf === 'g' ? r.g : surf === 'c' ? r.c : r.h) + 0.4 * r.e;

  async function matchFacts({ home, away, competition }) {
    if (!home || !away) return null;
    const players = await ratings();
    if (!players) return { noData: true, reason: 'base Elo indisponible (téléchargement des données tennis échoué)' };
    const p1 = findPlayer(home, players), p2 = findPlayer(away, players);
    if (!p1 || !p2) {
      const miss = [!p1 ? home : null, !p2 ? away : null].filter(Boolean).join(' et ');
      return { noData: true, reason: `joueur(s) hors base Elo récente : ${miss}` };
    }
    const surf = detectSurface(competition);
    const R1 = surfRating(p1.r, surf), R2 = surfRating(p2.r, surf);
    const prob1 = 1 / (1 + Math.pow(10, (R2 - R1) / 400));
    const facts = {
      tennis: true, surface: SURF_LABEL[surf],
      p1: { name: home, elo: Math.round(R1), matches: p1.r.n },
      p2: { name: away, elo: Math.round(R2), matches: p2.r.n },
      prob1: Math.round(prob1 * 1000) / 10, prob2: Math.round((1 - prob1) * 1000) / 10,
      source: 'elo-tennis'
    };
    facts.text = `# DONNÉES RÉELLES (Elo tennis — Tennis Abstract, ${SURF_LABEL[surf]}) :
- Elo (ajusté surface) : ${home} ${facts.p1.elo} vs ${away} ${facts.p2.elo}.
- Probabilité MODÈLE Elo : ${home} ${facts.prob1} % / ${away} ${facts.prob2} %. Utilise-la comme ancrage statistique fort ; ne t'en écarte qu'avec un fait concret (blessure, forme, abandon).`;
    return facts;
  }

  return { matchFacts, ratings };
})();
