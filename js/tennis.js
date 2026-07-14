/* ==========================================================================
   BetSmart AI — Modèle Elo tennis (côté client léger)
   Les ratings Elo (global + par surface) sont précalculés et servis en
   fichier statique same-origin : ./data/tennis-elo.json (source :
   Tennis Abstract, la référence du domaine). Aucun appel réseau externe,
   aucun token — incassable. Caché en mémoire + IndexedDB 24 h.
   ========================================================================== */
'use strict';

const TennisElo = (() => {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3);

  let mem = null; // cache mémoire de session
  let lastDiag = '';
  async function ratings() {
    if (mem && Date.now() - mem.at < 6 * 3600e3) return mem.players;
    // Cache IndexedDB 24 h
    try {
      const c = await DB.getSetting('tennisEloCache');
      if (c && c.players && Date.now() - c.at < 24 * 3600e3) { mem = c; return c.players; }
    } catch (_) {}
    lastDiag = '';
    try {
      const r = await fetch('./data/tennis-elo.json', { cache: 'default' });
      if (!r.ok) { lastDiag = 'fichier Elo introuvable (HTTP ' + r.status + ')'; return null; }
      const j = await r.json();
      if (j && j.players && Object.keys(j.players).length) {
        mem = { at: Date.now(), players: j.players, updated: j.updated };
        try { await DB.setSetting('tennisEloCache', mem, { silent: true }); } catch (_) {}
        return j.players;
      }
      lastDiag = 'base Elo vide';
    } catch (e) { lastDiag = 'lecture : ' + String((e && e.message) || e); }
    return null;
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

  const rankLabel = (r) => (r && r.r ? '#' + r.r + ' ' + (r.t === 'wta' ? 'WTA' : 'ATP') : (r && r.t === 'wta' ? 'WTA' : 'ATP'));

  async function matchFacts({ home, away, competition }) {
    if (!home || !away) return null;
    const players = await ratings();
    if (!players) return { noData: true, reason: 'base Elo indisponible (' + (lastDiag || 'raison inconnue') + ')' };
    const p1 = findPlayer(home, players), p2 = findPlayer(away, players);
    if (!p1 || !p2) {
      const miss = [!p1 ? home : null, !p2 ? away : null].filter(Boolean).join(' et ');
      return { noData: true, reason: `joueur(s) hors base Elo (top ~230 ATP/WTA) : ${miss}` };
    }
    const surf = detectSurface(competition);
    const R1 = surfRating(p1.r, surf), R2 = surfRating(p2.r, surf);
    const prob1 = 1 / (1 + Math.pow(10, (R2 - R1) / 400));
    const facts = {
      tennis: true, surface: SURF_LABEL[surf], updated: mem && mem.updated,
      p1: { name: home, elo: Math.round(R1), rank: rankLabel(p1.r) },
      p2: { name: away, elo: Math.round(R2), rank: rankLabel(p2.r) },
      prob1: Math.round(prob1 * 1000) / 10, prob2: Math.round((1 - prob1) * 1000) / 10,
      source: 'elo-tennis'
    };
    facts.text = `# DONNÉES RÉELLES (Elo tennis — Tennis Abstract, surface ${SURF_LABEL[surf]}) :
- Elo ajusté surface : ${home} ${facts.p1.elo} (${facts.p1.rank}) vs ${away} ${facts.p2.elo} (${facts.p2.rank}).
- Probabilité MODÈLE Elo : ${home} ${facts.prob1} % / ${away} ${facts.prob2} %. Utilise-la comme ancrage statistique fort ; ne t'en écarte qu'avec un fait concret et récent (blessure, forme, abandon, tête-à-tête).`;
    return facts;
  }

  return { matchFacts, ratings };
})();
