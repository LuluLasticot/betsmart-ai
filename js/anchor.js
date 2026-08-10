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

  // Marqueurs d'équipe féminine. Sans ce garde-fou, « Atlanta Dream W » (WNBA)
  // était résolu vers les « Atlanta Hawks » (NBA) parce que l'alias « atlanta »
  // suffisait : un faux appariement produit un modèle totalement faux, ce qui
  // est bien pire que pas de modèle du tout.
  const FEM = /(^|\s)(w|f|fem|femmes?|dames?|women|wnba)(\s|$)/;

  /** Proximité par jetons entre deux libellés, tolérante aux abréviations de ville.
      La normalisation se fait sur le plus COURT des deux libellés, ce qui permet
      à « Lakers » de retrouver « Los Angeles Lakers ». Contrepartie : un libellé
      d'un seul mot obtiendrait un score parfait dès qu'un mot correspond —
      l'alias « reds » gagnait ainsi contre « BOS Red Sox ». On exige donc au
      moins deux jetons de part et d'autre pour la recherche floue ; les libellés
      d'un mot restent gérés par la correspondance exacte, en amont. */
  function nameScore(a, b) {
    const wa = norm(a).split(' ').filter(Boolean);
    const wb = norm(b).split(' ').filter(Boolean);
    if (wa.length < 2 || wb.length < 2) return 0;
    let hits = 0;
    for (const w of wa) {
      if (wb.some((v) => v === w || (w.length >= 3 && v.startsWith(w)) || (v.length >= 3 && w.startsWith(v)))) hits++;
    }
    return hits / Math.min(wa.length, wb.length);
  }

  /**
   * Résout un nom d'équipe vers une entrée de table.
   * Deux exigences, apprises d'un faux positif : le meilleur candidat doit
   * dépasser un seuil de proximité ET devancer nettement le deuxième, sinon
   * l'appariement est ambigu et on préfère ne rien renvoyer.
   */
  function lookup(name, t) {
    if (!t || !t.teams) return null;
    const n = norm(name);
    if (!n) return null;

    // Une équipe féminine ne doit jamais tomber sur une table masculine, et
    // réciproquement : le nom de ville est souvent identique.
    const wantFem = FEM.test(' ' + n + ' ');
    const tableFem = /w/i.test(String(t.league || '')) && /wnba|femin/i.test(String(t.league || ''));
    if (wantFem !== tableFem) return null;

    if (t.teams[n]) return { key: n, ...t.teams[n] };
    const ali = t.aliases && t.aliases[n];
    if (ali && t.teams[ali]) return { key: ali, ...t.teams[ali] };

    // Recherche floue : on note tous les candidats et on n'accepte qu'un
    // gagnant net (aliases inclus, ramenés à leur équipe canonique).
    const scores = new Map();
    const note = (label, key) => {
      const sc = nameScore(n, label);
      if (sc > (scores.get(key) || 0)) scores.set(key, sc);
    };
    for (const k of Object.keys(t.teams)) note(k, k);
    for (const [a, k] of Object.entries(t.aliases || {})) if (t.teams[k]) note(a, k);

    const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]);
    if (!ranked.length) return null;
    const [bestKey, bestScore] = ranked[0];
    const second = ranked[1] ? ranked[1][1] : 0;
    if (bestScore < 0.6 || (bestScore - second) < 0.15) return null;
    return { key: bestKey, ...t.teams[bestKey] };
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
    // Plusieurs ligues, une table chacune : les efficacités ne sont pas
    // comparables d'une ligue à l'autre (rythme et niveau différents), donc
    // on cherche la table où LES DEUX équipes existent.
    let t = null, H = null, A = null;
    for (const name of ['basket-ratings', 'wnba-ratings']) {
      const cand = await table(name);
      const h = lookup(home, cand), a = lookup(away, cand);
      if (h && a) { t = cand; H = h; A = a; break; }
    }
    if (!t) return null;
    const hca = t.hca ?? 2.5, sigma = t.sigma ?? 11.5;
    const margin = (H.mov - A.mov) + hca;
    const pHome = normCdf(margin / sigma);
    return {
      sport: 'basketball', source: `Basketball-Reference ${t.league || 'NBA'} ${t.season}`, updated: t.updated,
      teams: { home: [home, H.key], away: [away, A.key] },
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
  async function baseball({ home, away, when }) {
    const t = await table('mlb-ratings');
    const H = lookup(home, t), A = lookup(away, t);
    if (!H || !A) return null;
    const a = H.pyth, b = A.pyth;
    // Log5 (Bill James) : probabilité que A batte B à partir de leurs niveaux
    let p = (a - a * b) / (a + b - 2 * a * b);
    p = Math.max(0.05, Math.min(0.95, p + (t.hfa ?? 0.04)));

    // Duel de lanceurs partants — le facteur dominant du baseball.
    let st = null;
    if (typeof MLB !== 'undefined') {
      try { st = await MLB.starters({ home, away, when }); } catch (_) {}
    }
    let quality = 'low', pitchLine = ' Lanceurs partants non disponibles : estimation grossière.';
    if (st && st.edge) {
      p = Math.max(0.05, Math.min(0.95, p + st.edge.delta));
      quality = st.edge.quality === 'ok' ? 'mid' : 'low';
      pitchLine = ' ' + st.edge.text;
    } else if (st && st.reason) {
      pitchLine = ` Lanceurs partants : ${st.reason}. Sans eux, abstiens-toi plutôt que d'estimer au jugé.`;
    }

    return {
      sport: 'baseball', source: `MLB StatsAPI ${t.season}`, updated: t.updated,
      teams: { home: [home, H.key], away: [away, A.key] },
      prob: { home: p, draw: null, away: 1 - p },
      // Même avec les partants, le baseball reste le sport le plus bruité :
      // on ne monte jamais au-delà de 'mid', ce qui garde un seuil de rejet large.
      quality,
      starters: st && st.edge ? { delta: st.edge.delta, home: st.home, away: st.away } : null,
      blind: `Niveau d'équipe ${t.season} — ${home} : ${H.rpg_for} points marqués et ${H.rpg_ag} encaissés par match, bilan ${H.w}-${H.l} · ${away} : ${A.rpg_for} marqués, ${A.rpg_ag} encaissés, bilan ${A.w}-${A.l}.${pitchLine}`
    };
  }

  /* ======================================================================
     FOOTBALL — Elo des clubs (déjà chargé par js/clubelo.js)
     ====================================================================== */
  async function football({ home, away }) {
    // Club Elo ne couvre que l'Europe (589 clubs). Pour l'Amérique du Sud,
    // la MLS ou l'Asie, on retombe sur une table d'Elo calculée localement.
    if (typeof ClubElo === 'undefined') return footballExtra({ home, away });
    let f = null;
    try { f = await ClubElo.matchFacts({ home, away }); } catch (_) { f = null; }
    if (!f || !f.clubElo) return footballExtra({ home, away });
    return {
      sport: 'football', source: 'Club Elo', updated: f.updated,
      teams: { home: [home, f.home.name], away: [away, f.away.name] },
      prob: { home: f.p1 / 100, draw: f.pX / 100, away: f.p2 / 100 },
      blind: `Elo des clubs — ${f.home.name} ${f.home.elo}${f.home.level ? ` (D${f.home.level} ${f.home.country})` : ''} vs ${f.away.name} ${f.away.elo}${f.away.level ? ` (D${f.away.level} ${f.away.country})` : ''}. L'Elo intègre le niveau des adversaires rencontrés, pas seulement les résultats.`
    };
  }

  /** Championnats hors Europe : Elo calculé à partir des résultats historiques
      de football-data.co.uk (Argentine, Brésil, MLS, Mexique, Japon…). */
  async function footballExtra({ home, away }) {
    const t = await table('football-elo-extra');
    const H = lookup(home, t), A = lookup(away, t);
    if (!H || !A) return null;
    const hfa = t.hfa ?? 60;
    const diff = (H.elo + hfa) - A.elo;
    const pNoDraw = 1 / (1 + Math.pow(10, -diff / 400));
    const pDraw = Math.max(0.06, 0.29 - Math.abs(diff) / 1600);
    const rest = 1 - pDraw;
    return {
      sport: 'football', source: `Elo ${t.source_short || 'football-data'} (${H.league || 'hors Europe'})`, updated: t.updated,
      teams: { home: [home, H.key], away: [away, A.key] },
      prob: { home: pNoDraw * rest, draw: pDraw, away: rest - pNoDraw * rest },
      quality: 'low',   // moins de matchs et sources moins riches qu'en Europe
      blind: `Elo local (${H.league || 'championnat hors Europe'}) — ${home} ${Math.round(H.elo)} vs ${away} ${Math.round(A.elo)}, calculé sur les résultats de la saison. Moins fiable que l'Elo européen : échantillon plus court.`
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
      teams: { home: [home, f.p1.name], away: [away, f.p2.name] },
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
  async function forMatch({ sport, home, away, competition, when }) {
    const s = norm(sport);
    for (const [re, fn] of ROUTES) {
      if (!re.test(s)) continue;
      try { return await fn({ home, away, competition, when }); } catch (_) { return null; }
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
  const NOISE = new Set(['fc', 'cf', 'ac', 'sc', 'as', 'de', 'la', 'le', 'les', 'du', 'des', 'victoire', 'vainqueur', 'win']);
  const words = (s) => norm(s).split(' ').filter((w) => w.length >= 2 && !NOISE.has(w));

  /** Score de proximité entre une sélection et un camp : nombre de mots communs,
      en tolérant les abréviations (« BOS Red Sox » vs « Boston Red Sox » →
      « bos » est un préfixe de « boston »). C'est le cas courant en MLB et NBA,
      où coteur abrège la ville et l'IA écrit le nom complet. */
  function affinity(selection, candidates) {
    const sw = words(selection);
    if (!sw.length) return 0;
    let best = 0;
    for (const c of candidates.filter(Boolean)) {
      const cw = words(c);
      if (!cw.length) continue;
      let hits = 0;
      for (const w of sw) {
        if (cw.some((x) => x === w || (w.length >= 3 && x.startsWith(w)) || (x.length >= 3 && w.startsWith(x)))) hits++;
      }
      best = Math.max(best, hits / Math.min(sw.length, cw.length));
    }
    return best;
  }

  function outcomeFor(anchor, matchLabel, marche, selection) {
    if (!anchor) return null;
    if (!/(1n2|^12$|vainqueur|winner|moneyline)/i.test(String(marche || ''))) return null;
    const sel = norm(selection);
    if (/^(nul|draw|match nul|x|n)$/.test(sel)) return anchor.prob.draw != null ? anchor.prob.draw : null;
    // Un handicap ou un total n'est pas l'issue « vainqueur » : ne pas rapprocher.
    if (/[+-]\s*\d|\bover\b|\bunder\b|plus de|moins de/i.test(String(selection))) return null;

    const parts = splitMatch(matchLabel) || {};
    const t = anchor.teams || {};

    // Codes 1N2 nus. Coteur libelle parfois la sélection « 1 » / « N » / « 2 »
    // en mettant le nom de l'équipe dans le nom du marché : aucun rapprochement
    // par nom n'était alors possible et seul le nul obtenait un ancrage.
    if (sel === '1') return anchor.prob.home;
    if (sel === '2') return anchor.prob.away;

    let sh = affinity(selection, [parts.home, ...(t.home || [])]);
    let sa = affinity(selection, [parts.away, ...(t.away || [])]);

    // Repli : le nom de l'équipe est dans le libellé du marché
    // (« 1N2 - Victoire Kairat Almaty »).
    if (sh < 0.5 && sa < 0.5) {
      const lbl = String(marche || '').replace(/^[^-–—]*[-–—]\s*/, '');
      sh = affinity(lbl, [parts.home, ...(t.home || [])]);
      sa = affinity(lbl, [parts.away, ...(t.away || [])]);
    }
    if (sh >= 0.5 && sh > sa) return anchor.prob.home;
    if (sa >= 0.5 && sa > sh) return anchor.prob.away;
    return null;
  }

  /** Verdict : { ok, modelProb, gap, reason }. ok=false → le pick est écarté. */
  function check(anchor, matchLabel, marche, selection, aiProb) {
    const mp = outcomeFor(anchor, matchLabel, marche, selection);
    if (mp == null || !(aiProb > 0 && aiProb < 1)) return { ok: true, modelProb: null, gap: null };
    let tol = TOL[anchor.sport] ?? 0.15;
    if (anchor.quality === 'low') tol += 0.06;      // modèle volontairement peu contraignant
    else if (anchor.quality === 'mid') tol += 0.03;  // partants connus : on resserre un peu
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
