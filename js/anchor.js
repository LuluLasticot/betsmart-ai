/* ==========================================================================
   BetSmart AI — Ancrage quantitatif par sport
   --------------------------------------------------------------------------
   Deux rôles bien séparés, qui correspondent aux deux phases du protocole :

   • PHASE A (aveugle) — `blind` : les FAITS BRUTS seulement (Elo, ORtg/DRtg,
     niveau Pythagenpat…). Surtout PAS la probabilité du modèle : si on la
     donnait à l'IA, elle la recopierait et son estimation cesserait d'être
     indépendante — tout l'intérêt du protocole disparaîtrait.

   • PHASE B (après coup) — `prob` : la probabilité du modèle, utilisée par
     l'app comme GARDE-FOU. Le backtest est sans appel : le modèle seul perd
     de l'argent (ROI −26 %), mais il repère très bien les estimations
     délirantes — précisément celles qui ont fait −58 % de ROI sur la tranche
     « +10-20 % d'edge ». On s'en sert donc pour écarter, pas pour parier.

   Tout vient de tables statiques régénérées chaque semaine : aucun appel à
   api-sports (quota gratuit : 100 requêtes/jour et par sport).
   ========================================================================== */
'use strict';

const Anchor = (() => {

  const norm = (s) => String(s || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  /* ---- Chargement paresseux et mis en cache des tables ---- */
  const tables = {};
  async function table(name) {
    if (tables[name] !== undefined) return tables[name];
    try {
      const r = await fetch(`data/${name}.json`, { cache: 'no-cache' });
      tables[name] = r.ok ? await r.json() : null;
    } catch (_) { tables[name] = null; }
    return tables[name];
  }

  /** Résout un nom d'équipe vers une entrée de table (exact → alias → inclusion). */
  function lookup(name, t) {
    if (!t || !t.teams) return null;
    const n = norm(name);
    if (!n) return null;
    if (t.teams[n]) return { key: n, ...t.teams[n] };
    const ali = t.aliases && t.aliases[n];
    if (ali && t.teams[ali]) return { key: ali, ...t.teams[ali] };
    // Inclusion : « Milwaukee Brewers (MLB) » → « milwaukee brewers »
    for (const k of Object.keys(t.teams)) {
      if (n === k || n.includes(k) || k.includes(n)) return { key: k, ...t.teams[k] };
    }
    for (const [a, k] of Object.entries(t.aliases || {})) {
      if (n === a || n.includes(a)) return t.teams[k] ? { key: k, ...t.teams[k] } : null;
    }
    return null;
  }

  /* ---- Loi normale centrée réduite (probabilité de couvrir une marge) ---- */
  function normCdf(z) {
    // Approximation d'Abramowitz-Stegun 26.2.17 (erreur < 7,5e-8)
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? 1 - p : p;
  }

  const pct = (x) => Math.round(x * 1000) / 10;

  /* ======================================================================
     BASKET — efficacité offensive/défensive ajustée → marge → probabilité
     Le basket est le plus prédictible des quatre : beaucoup de possessions
     par match, donc peu de variance relative. Une marge projetée se convertit
     directement en probabilité via une loi normale (σ ≈ 11,5 points en NBA).
     ====================================================================== */
  async function basketball({ home, away }) {
    const t = await table('basket-ratings');
    const H = lookup(home, t), A = lookup(away, t);
    if (!H || !A) return null;
    const hca = t.hca ?? 2.5, sigma = t.sigma ?? 11.5;
    const margin = (H.mov - A.mov) + hca;
    const pHome = normCdf(margin / sigma);
    return {
      sport: 'basketball', source: `Basketball-Reference ${t.season}`, updated: t.updated,
      prob: { home: pHome, draw: null, away: 1 - pHome },
      margin: Math.round(margin * 10) / 10,
      // Phase A : uniquement les notes brutes, jamais la marge ni la probabilité.
      blind: `Efficacité ajustée (${t.season}) — ${home} : attaque ${H.ortg}, défense ${H.drtg} pour 100 possessions, bilan ${H.w}-${H.l} · ${away} : attaque ${A.ortg}, défense ${A.drtg}, bilan ${A.w}-${A.l}.${t.note ? ' ' + t.note : ''}`
    };
  }

  /* ======================================================================
     BASEBALL — Log5 sur le niveau Pythagenpat
     Sport le plus bruité des quatre : même la meilleure équipe perd 4 matchs
     sur 10. Sans le lanceur partant annoncé, l'estimation reste grossière —
     d'où une qualité dégradée qui rendra le Radar plus exigeant.
     ====================================================================== */
  async function baseball({ home, away }) {
    const t = await table('mlb-ratings');
    const H = lookup(home, t), A = lookup(away, t);
    if (!H || !A) return null;
    const a = H.pyth, b = A.pyth;
    // Log5 (Bill James) : probabilité que A batte B à partir de leurs niveaux
    let p = (a - a * b) / (a + b - 2 * a * b);
    p = Math.max(0.05, Math.min(0.95, p + (t.hfa ?? 0.04)));
    return {
      sport: 'baseball', source: `MLB StatsAPI ${t.season}`, updated: t.updated,
      prob: { home: p, draw: null, away: 1 - p },
      quality: 'low',   // le partant n'est pas dans la table → prudence accrue
      blind: `Niveau d'équipe ${t.season} — ${home} : ${H.rpg_for} points marqués et ${H.rpg_ag} encaissés par match, bilan ${H.w}-${H.l} · ${away} : ${A.rpg_for} marqués, ${A.rpg_ag} encaissés, bilan ${A.w}-${A.l}. Le lanceur partant n'est PAS inclus : vérifie-le, il pèse plus que tout le reste.`
    };
  }

  /* ======================================================================
     FOOTBALL — Elo des clubs (déjà chargé par js/clubelo.js)
     ====================================================================== */
  async function football({ home, away }) {
    if (typeof ClubElo === 'undefined') return null;
    let f = null;
    try { f = await ClubElo.matchFacts({ home, away }); } catch (_) { return null; }
    if (!f || !f.clubElo) return null;
    return {
      sport: 'football', source: 'Club Elo', updated: f.updated,
      prob: { home: f.p1 / 100, draw: f.pX / 100, away: f.p2 / 100 },
      blind: `Elo des clubs — ${f.home.name} ${f.home.elo}${f.home.level ? ` (D${f.home.level} ${f.home.country})` : ''} vs ${f.away.name} ${f.away.elo}${f.away.level ? ` (D${f.away.level} ${f.away.country})` : ''}. L'Elo intègre le niveau des adversaires rencontrés, pas seulement les résultats.`
    };
  }

  /* ======================================================================
     TENNIS — Elo par surface + vitesse du court (js/tennis.js)
     ====================================================================== */
  async function tennis({ home, away, competition }) {
    if (typeof TennisElo === 'undefined') return null;
    let f = null;
    try { f = await TennisElo.matchFacts({ home, away, competition }); } catch (_) { return null; }
    if (!f || !f.tennis || f.noData) return null;
    const speed = f.speed
      ? ` Vitesse du court (indice Tennis Abstract, 1.00 = moyenne du circuit) : ${f.speed.s} — ${f.speed.s >= 1.05 ? 'conditions rapides, avantage aux gros serveurs' : f.speed.s <= 0.9 ? 'conditions lentes, avantage aux relanceurs' : 'conditions neutres'}.`
      : '';
    return {
      sport: 'tennis', source: 'Tennis Abstract (Elo par surface)', updated: f.updated,
      prob: { home: f.prob1 / 100, draw: null, away: f.prob2 / 100 },
      blind: `Elo ajusté à la surface (${f.surface}) — ${f.p1.name} ${f.p1.elo} (${f.p1.rank}) vs ${f.p2.name} ${f.p2.elo} (${f.p2.rank}).${speed}`
    };
  }

  const ROUTES = [
    [/tennis/, tennis],
    [/foot|soccer/, football],
    [/basket/, basketball],
    [/base ?ball/, baseball]
  ];

  /** Ancrage d'un match. Renvoie null si le sport ou les équipes sont inconnus
      — le Radar fonctionne alors comme avant, sans garde-fou. */
  async function forMatch({ sport, home, away, competition }) {
    const s = norm(sport);
    for (const [re, fn] of ROUTES) {
      if (!re.test(s)) continue;
      try { return await fn({ home, away, competition }); } catch (_) { return null; }
    }
    return null;
  }

  /** Sépare « Équipe A – Équipe B » en deux camps (tirets longs, courts, « vs »). */
  function splitMatch(label) {
    const m = String(label || '').split(/\s+(?:[–—]|-|vs\.?)\s+/i);
    return m.length >= 2 ? { home: m[0].trim(), away: m.slice(1).join(' ').trim() } : null;
  }

  /* ======================================================================
     GARDE-FOU (phase B)
     Compare l'estimation de l'IA à celle du modèle pour la MÊME issue.
     Un écart considérable sans justification factuelle = estimation à écarter.
     ====================================================================== */
  // Plus le modèle du sport est fiable, plus le désaccord toléré est étroit.
  // Basket : beaucoup de possessions, faible variance → modèle solide, seuil serré.
  // Football : le nul rend l'Elo bruité → seuil plus large.
  // Baseball : modèle sans le partant → on ne peut pas lui faire confiance pour
  // écarter un pick, d'où le seuil le plus permissif (encore élargi par quality:'low').
  const TOL = { basketball: 0.12, tennis: 0.14, football: 0.16, baseball: 0.10 };

  /** Quelle issue du modèle correspond à cette sélection ? null si non couverte
      (over/under, handicap… : le garde-fou ne s'applique qu'au vainqueur/1N2). */
  function outcomeFor(anchor, matchLabel, marche, selection) {
    if (!anchor) return null;
    if (!/^(1n2|12|vainqueur|winner|moneyline)/i.test(String(marche || ''))) return null;
    const parts = splitMatch(matchLabel);
    if (!parts) return null;
    const sel = norm(selection), h = norm(parts.home), a = norm(parts.away);
    if (/^(nul|draw|match nul|x|n)$/.test(sel)) return anchor.prob.draw != null ? anchor.prob.draw : null;
    const hitH = sel.includes(h) || h.includes(sel);
    const hitA = sel.includes(a) || a.includes(sel);
    if (hitH && !hitA) return anchor.prob.home;
    if (hitA && !hitH) return anchor.prob.away;
    return null;
  }

  /** Verdict : { ok, modelProb, gap, reason }. ok=false → le pick est écarté. */
  function check(anchor, matchLabel, marche, selection, aiProb) {
    const mp = outcomeFor(anchor, matchLabel, marche, selection);
    if (mp == null || !(aiProb > 0 && aiProb < 1)) return { ok: true, modelProb: null, gap: null };
    let tol = TOL[anchor.sport] ?? 0.15;
    if (anchor.quality === 'low') tol += 0.06; // modèle volontairement peu contraignant
    const gap = aiProb - mp;
    if (gap > tol) {
      return {
        ok: false, modelProb: mp, gap,
        reason: `l'IA annonce ${pct(aiProb)} % là où le modèle (${anchor.source}) donne ${pct(mp)} % — écart de ${pct(gap)} points, au-delà du seuil de ${pct(tol)} points`
      };
    }
    return { ok: true, modelProb: mp, gap };
  }

  return { forMatch, check, outcomeFor, splitMatch, normCdf, table };
})();
