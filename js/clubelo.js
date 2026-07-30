/* ==========================================================================
   BetSmart AI — Elo des clubs (football)
   Équivalent de l'Elo tennis : ancrage statistique long terme qui intègre le
   NIVEAU des adversaires, là où le modèle Poisson ne voit que les buts des
   derniers matchs. Les deux se corrigent mutuellement.
   Source : clubelo.com, régénérée chaque semaine en fichier statique.
   ========================================================================== */
'use strict';

const ClubElo = (() => {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'fc', 'cf', 'ac', 'as', 'sc', 'rc', 'club', 'olympique', 'sporting', 'stade', 'real', 'cd', 'ca', 'sv', 'if', 'bk', 'fk', 'us']);
  const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));

  const HFA = 65; // avantage du terrain, en points d'Elo (usage standard Club Elo)
  let table = null;

  async function load() {
    if (table !== null) return table;
    try {
      const r = await fetch('./data/club-elo.json', { cache: 'default' });
      table = r.ok ? await r.json() : false;
    } catch (_) { table = false; }
    return table;
  }

  /** Retrouve un club par nom (exact, puis par recouvrement de mots). */
  function find(name, clubs) {
    const q = norm(name);
    if (!q) return null;
    if (clubs[q]) return clubs[q];
    const qt = toks(name);
    if (!qt.length) return null;
    let best = null, score = 0;
    for (const key in clubs) {
      const kt = key.split(' ');
      const overlap = qt.filter((t) => kt.includes(t)).length;
      const strong = qt.some((t) => t.length >= 4 && kt.includes(t));
      if (overlap > score && strong) { score = overlap; best = clubs[key]; }
    }
    return best;
  }

  /**
   * Probabilités 1N2 à partir de l'écart d'Elo (avantage du terrain inclus).
   * Le nul est estimé par une fonction décroissante de l'écart : plus les
   * équipes sont proches, plus le nul est probable (~28 % à écart nul).
   */
  async function matchFacts({ home, away }) {
    const t = await load();
    if (!t || !t.clubs) return null;
    const H = find(home, t.clubs), A = find(away, t.clubs);
    if (!H || !A) return null;

    const diff = (H.e + HFA) - A.e;
    const pHomeVsAway = 1 / (1 + Math.pow(10, -diff / 400));   // proba hors nul
    const pDraw = Math.max(0.06, 0.29 - Math.abs(diff) / 1600); // nul décroissant
    const rest = 1 - pDraw;
    const p1 = pHomeVsAway * rest, p2 = rest - p1;
    const r = (x) => Math.round(x * 1000) / 10;

    const facts = {
      clubElo: true, updated: t.updated,
      home: { name: H.n, elo: H.e, country: H.c, level: H.l },
      away: { name: A.n, elo: A.e, country: A.c, level: A.l },
      p1: r(p1), pX: r(pDraw), p2: r(p2), diff: Math.round(diff)
    };
    facts.text = `## ELO DES CLUBS (clubelo.com — ancrage long terme, intègre le niveau des adversaires) :
- Elo : ${H.n} ${H.e}${H.l ? ` (D${H.l} ${H.c})` : ''} vs ${A.n} ${A.e}${A.l ? ` (D${A.l} ${A.c})` : ''} — écart ${facts.diff > 0 ? '+' : ''}${facts.diff} pts pour ${facts.diff >= 0 ? H.n : A.n} (avantage du terrain inclus).
- Probabilités MODÈLE Elo : ${H.n} ${facts.p1} % / Nul ${facts.pX} % / ${A.n} ${facts.p2} %.
Croise-les avec le modèle de buts : un désaccord marqué entre les deux modèles est un signal de prudence, pas une opportunité.`;
    return facts;
  }

  return { matchFacts, load };
})();
