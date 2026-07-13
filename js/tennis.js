/* ==========================================================================
   BetSmart AI — Modèle Elo tennis (côté client)
   Charge la table de ratings (surface) calculée par /api/tennis (données
   Sackmann), détecte la surface du tournoi, et renvoie une probabilité
   modèle pour un match — injectée au Radar comme ancrage statistique fort.
   Couvre l'angle mort tennis (api-sports ne le propose pas). Défensif.
   ========================================================================== */
'use strict';

const TennisElo = (() => {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3);

  let cache = null; // { at, players }
  async function ratings() {
    if (cache && Date.now() - cache.at < 6 * 3600e3) return cache.players;
    try {
      const r = await fetch('/api/tennis');
      const j = await r.json();
      if (j && j.ok && j.players) { cache = { at: Date.now(), players: j.players }; return j.players; }
    } catch (_) {}
    return null;
  }

  const SURF_LABEL = { h: 'dur', c: 'terre battue', g: 'gazon' };
  function detectSurface(comp) {
    const n = norm(comp);
    if (/wimbledon|halle|queens|eastbourne|mallorca|stuttgart|hertogenbosch|bois le duc|newport/.test(n)) return 'g';
    if (/roland|french open|gstaad|umag|bastad|kitzbuhel|hamburg|monte carlo|madrid|rome|barcelona|munich|estoril|bucharest|geneva|houston|marrakech|cordoba|santiago|buenos aires|rio de|sao paulo|kitzbuhel|bogota|umag/.test(n)) return 'c';
    return 'h'; // dur par défaut (majorité du calendrier)
  }

  function findPlayer(name, players) {
    const q = norm(name);
    if (players[q]) return { key: q, r: players[q] };
    const qt = toks(name);
    let best = null, score = 0;
    for (const key in players) {
      const kt = key.split(' ');
      const overlap = qt.filter((t) => kt.includes(t)).length;
      // exige au moins un token « nom de famille » (≥ 5 lettres) commun
      const strong = qt.some((t) => t.length >= 5 && kt.includes(t));
      if (overlap > score && strong) { score = overlap; best = key; }
    }
    return best ? { key: best, r: players[best] } : null;
  }

  const surfRating = (r, surf) => {
    const s = surf === 'g' ? r.g : surf === 'c' ? r.c : r.h;
    return 0.6 * s + 0.4 * r.e; // ancrage surface + overall
  };

  /** Faits Elo pour un match tennis : proba modèle + Elo par joueur. */
  async function matchFacts({ home, away, competition }) {
    if (!home || !away) return null;
    const players = await ratings();
    if (!players) return { noData: true, reason: 'base Elo indisponible (réessayez dans un instant)' };
    const p1 = findPlayer(home, players), p2 = findPlayer(away, players);
    if (!p1 || !p2) {
      const miss = [!p1 ? home : null, !p2 ? away : null].filter(Boolean).join(' et ');
      return { noData: true, reason: `joueur(s) introuvable(s) dans la base Elo : ${miss}` };
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
