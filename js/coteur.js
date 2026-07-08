/* ==========================================================================
   BetSmart AI — Cotes en temps réel via coteur.com (usage privé)
   Portage vanilla du scraper (app statique, sans build) :
     • métadonnées des matchs : pages liste coteur.com via proxy CORS
     • cotes réelles : API interne oddsv2.coteur.com/odds/getFullOdds/{id}
       authentifiée par un token AES quotidien (CryptoJS.AES.encrypt(date, "1231"))
   Réservé à un usage privé : le scraping est contraire aux CGU de coteur.com,
   ne pas déployer publiquement.
   ========================================================================== */
'use strict';

const Coteur = (() => {
  const COTEUR = 'https://www.coteur.com';
  const ODDS_API = 'https://oddsv2.coteur.com/odds/getFullOdds';

  // Proxies CORS publics (essayés dans l'ordre). allorigins enveloppe la
  // réponse dans { contents }, corsproxy renvoie le corps brut.
  const PROXIES = [
    { url: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, wrapped: true },
    { url: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`, wrapped: false },
    { url: (u) => `https://thingproxy.freeboard.io/fetch/${u}`, wrapped: false }
  ];

  // Slugs coteur.com vérifiés
  const SPORT_PAGES = {
    football: 'cotes-foot', foot: 'cotes-foot',
    tennis: 'cotes-tennis',
    basketball: 'cotes-basket', basket: 'cotes-basket',
    rugby: 'cotes-rugby',
    baseball: 'cotes-baseball',
    boxe: 'cotes-boxe', boxing: 'cotes-boxe',
    volley: 'cotes-volley', volleyball: 'cotes-volley',
    mma: 'cotes-mma',
    handball: 'cotes-hand', hand: 'cotes-hand',
    hockey: 'cotes-hockey'
  };

  // ID bookmaker coteur → nom lisible. IDs validés en production ;
  // les inconnus s'affichent « Cote FR » (jamais un mauvais nom).
  const BOOK_NAMES = {
    22: 'Winamax', 24: 'Betclic', 25: 'Unibet', 33: 'Unibet', 37: 'PMU',
    43: 'Betsson', 44: 'Bwin', 21: 'bet365', 45: 'Pinnacle', 36: '1xBet', 23: 'Betway'
  };
  const bookName = (id) => BOOK_NAMES[id] || 'Cote FR';

  const listCache = new Map();   // sport -> { at, matches }
  const oddsCache = new Map();   // rencId -> { at, data }

  // Backend serverless privé (/api/coteur) : détecté une fois, puis mémorisé.
  // Si présent → fetch direct côté serveur (pas de CORS, token en header, plus fiable).
  // Sinon → repli sur les proxies CORS publics.
  let backend = null; // null = inconnu, true/false = testé
  async function hasBackend() {
    if (backend !== null) return backend;
    try {
      const r = await fetch('/api/coteur?type=ping', { cache: 'no-store' });
      const j = await r.json();
      backend = !!j.ok;
    } catch (_) { backend = false; }
    return backend;
  }

  /* ---- Normalisation & tokens (matching de noms) ---- */
  const norm = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'fc', 'cf', 'ac', 'as', 'sc', 'rc', 'og', 'club', 'olympique', 'sporting', 'stade', 'real']);
  const toks = (s) => norm(s).split(' ').filter((t) => (t.length >= 3 && !STOP.has(t)) || ['om', 'ol', 'psg'].includes(t));
  const initials = (name) => {
    const w = norm(name).split(' ').filter(Boolean);
    return new Set([w.map((x) => x[0]).join(''), w.filter((x) => !['de', 'du', 'des', 'le', 'la', 'les'].includes(x)).map((x) => x[0]).join('')]);
  };
  const teamMatch = (queryToks, evName) => {
    const t = norm(evName), inits = initials(evName);
    return queryToks.some((q) => (q.length >= 3 && t.includes(q)) || inits.has(q));
  };

  /* ------------------------------------------------------------------
     Token AES quotidien (identique au bundle coteur : date UTC, clé "1231")
     ------------------------------------------------------------------ */
  function generateToken() {
    if (typeof CryptoJS === 'undefined') throw new Error('CryptoJS non chargé (script CDN manquant).');
    const t = new Date();
    const utc = new Date(t.getTime() + 60000 * t.getTimezoneOffset());
    const dateStr = utc.toLocaleDateString('fr-FR'); // "JJ/MM/AAAA"
    return CryptoJS.AES.encrypt(dateStr, '1231').toString();
  }

  /* ------------------------------------------------------------------
     Récupération via proxies
     ------------------------------------------------------------------ */
  async function proxyFetch(targetUrl, { timeout = 9000 } = {}) {
    for (const proxy of PROXIES) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), timeout);
        const res = await fetch(proxy.url(targetUrl), { signal: ctrl.signal });
        clearTimeout(to);
        if (!res.ok && !proxy.wrapped) continue;
        const body = proxy.wrapped ? (await res.json())?.contents ?? '' : await res.text();
        if (body && body.length > 30) return body;
      } catch (_) { /* proxy suivant */ }
    }
    return '';
  }

  /* ------------------------------------------------------------------
     Pages liste : métadonnées des matchs (équipes, ligue, date, rencId)
     ------------------------------------------------------------------ */
  const extractRencId = (href) => (href && href.match(/(\d+)\/?$/) || [])[1] || null;

  function parseCoteurDate(str) {
    const now = new Date();
    const [dm, time] = str.split(' ');
    const [day, month] = dm.split('/').map(Number);
    const [h, min] = time.split(':').map(Number);
    const d = new Date(now.getFullYear(), month - 1, day, h, min);
    if (d.getTime() < now.getTime() - 180 * 864e5) d.setFullYear(now.getFullYear() + 1);
    return d;
  }

  function parseMatchList(html) {
    const out = [];
    if (!html) return out;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('a[href^="/cote/"]').forEach((el) => {
      try {
        const href = el.getAttribute('href');
        const rencId = extractRencId(href);
        if (!rencId) return;
        const full = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const dm = full.match(/(\d{2}\/\d{2}\s\d{2}:\d{2})/);
        if (!dm) return;
        const after = full.slice(full.indexOf(dm[1]) + dm[1].length).trim();
        if (!after.includes(' vs ')) return;
        const vi = after.indexOf(' vs ');
        const teamA = after.slice(0, vi).trim();
        const teamB = after.slice(vi + 4).replace(/[\d.]+$/, '').replace(/\.{2,}.*$/, '').trim();
        if (!teamA || !teamB) return;
        const before = full.slice(0, full.indexOf(dm[1])).trim();
        const league = before.replace(/\s*TRJ\s*:?\s*[\d.,]+\s*%/gi, '').replace(/[-–]/g, ' ').trim() || 'Coteur';
        const slug = (href.match(/\/cote\/([a-z0-9-]+)/i) || [])[1] || null;
        out.push({ rencId, slug, teamA, teamB, league, date: parseCoteurDate(dm[1]) });
      } catch (_) { /* ignore */ }
    });
    return out;
  }

  async function getMatchList(sportPage) {
    const cached = listCache.get(sportPage);
    if (cached && Date.now() - cached.at < 300e3) return cached.matches;

    let html = '';
    if (await hasBackend()) {
      try {
        const r = await fetch(`/api/coteur?type=list&page=${encodeURIComponent(sportPage)}`);
        const j = await r.json();
        html = j.ok ? j.html : '';
      } catch (_) { /* repli proxies */ }
    }
    if (!html) html = await proxyFetch(`${COTEUR}/${sportPage}`);

    const matches = parseMatchList(html);
    listCache.set(sportPage, { at: Date.now(), matches });
    return matches;
  }

  /* ------------------------------------------------------------------
     API cotes : getFullOdds/{rencId}
     ------------------------------------------------------------------ */
  async function getFullOdds(rencId) {
    const cached = oddsCache.get(rencId);
    if (cached && Date.now() - cached.at < 300e3) return cached.data;

    let raw = null;

    // 1) Backend serverless : token généré et envoyé en header côté serveur
    if (await hasBackend()) {
      try {
        const r = await fetch(`/api/coteur?type=odds&id=${encodeURIComponent(rencId)}`);
        const j = await r.json();
        if (j.ok && Array.isArray(j.data?.odds)) raw = j.data;
      } catch (_) { /* repli proxies */ }
    }

    // 2) Repli proxies publics (token généré côté client, en query param)
    if (!raw) {
      const token = generateToken();
      const body = await proxyFetch(`${ODDS_API}/${rencId}?token=${encodeURIComponent(token)}`, { timeout: 9000 });
      try { raw = JSON.parse(body); } catch (_) { return null; }
    }

    if (!raw || raw.success === false || !Array.isArray(raw.odds)) return null;
    oddsCache.set(rencId, { at: Date.now(), data: raw });
    return raw;
  }

  /* ------------------------------------------------------------------
     Extraction des cotes par bookmaker pour un type de pari
     Réponse coteur : odds[] avec { typename, bestfr:{outcome:{bookId,cote}},
     best:{...}, et éventuellement une liste complète par book }
     ------------------------------------------------------------------ */
  /** Trouve l'entrée de type de pari (typename + special éventuel). */
  function betEntry(raw, typename, special) {
    return raw.odds.find((o) => o.typename === typename && (special === undefined || o.special === special)) || null;
  }

  /**
   * Structure réelle coteur : chaque entry a `bestfr` (meilleur book français
   * par issue) et `best` (meilleur book global). Pas de liste complète par book.
   * On renvoie la meilleure cote FR pour la première issue trouvée.
   *   1N2 : '1'=domicile, '0'=nul, '2'=extérieur
   *   OU  : '3'=OVER (plus de), '2'=UNDER (moins de) ; special '2-5' = 2,5
   */
  function bestForOutcome(entry, keys, { frOnly = true, allowed = null } = {}) {
    if (!entry) return null;
    const src = (frOnly && entry.bestfr) ? entry.bestfr : (entry.best || entry.bestfr || {});
    for (const k of keys) {
      const o = src[k];
      if (o && Number(o.cote) > 1) {
        const name = bookName(o.bookId);
        const mine = !allowed || allowed.has(norm(name));
        return { book: name, price: Number(o.cote), bookId: o.bookId, fr: true, mine, notMine: !mine };
      }
    }
    return null;
  }

  /** Compat : renvoie [meilleure cote FR] pour l'outcome (array pour l'UI). */
  function pricesForOutcome(entry, keys) {
    const b = bestForOutcome(entry, keys);
    return b ? [b] : [];
  }

  /** Encode un seuil over/under au format coteur : 2.5 → "2-5", 3 → "3". */
  const encodeThreshold = (thr) => String(thr).replace('.', '-');

  /** Détermine le marché + issue coteur ciblés par la sélection du pick. */
  function resolveOutcome(pick, match) {
    const sel = norm(pick.selection);
    // Over / Under (buts/points) : special = seuil encodé, over='3', under='2'
    const thrRaw = (String(pick.selection || '').match(/(\d+(?:[.,]\d)?)/) || [])[1];
    if (thrRaw && /\b(plus|moins|over|under)\b|but|point/.test(sel)) {
      const thr = thrRaw.replace(',', '.');
      const over = /plus|over/.test(sel);
      return { typename: 'OU', special: encodeThreshold(thr), keys: [over ? '3' : '2'] };
    }
    // Nul
    if (/\bnul\b|draw|match nul/.test(sel)) return { typename: '1n2', keys: ['0'] };
    // Victoire → domicile ('1') ou extérieur ('2')
    const selToks = toks(pick.selection.replace(/victoire|gagnant|vainqueur|gagne|win/gi, ''));
    if (match && teamMatch(selToks, match.teamB) && !teamMatch(selToks, match.teamA)) return { typename: '1n2', keys: ['2'] };
    return { typename: '1n2', keys: ['1'] };
  }

  /* ------------------------------------------------------------------
     API publique
     ------------------------------------------------------------------ */

  /** Ensemble de noms de books autorisés (normalisés) depuis une liste. */
  function allowedSet(bookNames) {
    if (!Array.isArray(bookNames) || !bookNames.length) return null;
    return new Set(bookNames.map((b) => norm(b)).filter(Boolean));
  }

  /** Vérifie un pick → cotes réelles par book (interface compatible Odds). */
  async function verifyPick(_key, pick, opts = {}) {
    const allowed = opts.allowed || allowedSet(opts.books);
    const page = SPORT_PAGES[norm(pick.sport).split(' ')[0]];
    if (!page) return { status: 'no_league' };

    const matches = await getMatchList(page);
    if (!matches.length) return { status: 'no_events' };

    const A = toks((pick.match || pick.event || '').split(/\s+[–—-]\s+|\s+vs\.?\s+/i)[0] || '');
    const B = toks((pick.match || pick.event || '').split(/\s+[–—-]\s+|\s+vs\.?\s+/i)[1] || '');
    if (!A.length || !B.length) return { status: 'no_match' };

    const dISO = pick.date_match || pick.date;
    const found = matches.find((m) => {
      if (dISO && Math.abs(m.date - new Date(dISO + 'T12:00:00')) > 36 * 864e5) return false;
      return (teamMatch(A, m.teamA) && teamMatch(B, m.teamB)) || (teamMatch(A, m.teamB) && teamMatch(B, m.teamA));
    });
    if (!found) return { status: 'no_match' };

    const raw = await getFullOdds(found.rencId);
    if (!raw) return { status: 'no_market', event: found };

    const target = resolveOutcome(pick, found);
    const entry = target.typename === 'OU'
      ? betEntry(raw, 'OU', target.special)
      : (betEntry(raw, '1n2') || betEntry(raw, '12'));
    if (!entry) return { status: 'no_market', event: found };

    const best = bestForOutcome(entry, target.keys, { allowed });
    if (!best) return { status: 'no_market', event: found };

    // Meilleure cote FR chez un book non configuré par l'utilisateur
    if (best.notMine) return { status: 'not_my_book', event: found, best, market: target.typename, source: 'coteur' };

    return { status: 'ok', event: found, prices: [best], best, market: target.typename, source: 'coteur' };
  }

  /** Liste des prochains matchs d'un sport avec meilleures cotes 1N2 (comparateur). */
  async function getUpcomingEvents(sport, { limit = 20, withOdds = true, concurrency = 3, books = null } = {}) {
    const allowed = allowedSet(books);
    const page = SPORT_PAGES[norm(sport).split(' ')[0]];
    if (!page) return []; // sport non couvert par coteur
    const matches = (await getMatchList(page))
      .filter((m) => m.date.getTime() > Date.now() - 3 * 3600e3)
      .sort((a, b) => a.date - b.date)
      .slice(0, limit);

    if (!withOdds) return matches.map((m) => ({ ...m, odds: null }));

    const results = [];
    for (let i = 0; i < matches.length; i += concurrency) {
      const batch = matches.slice(i, i + concurrency);
      const settled = await Promise.all(batch.map(async (m) => {
        try {
          const raw = await getFullOdds(m.rencId);
          if (!raw) return { ...m, odds: null };
          const entry = betEntry(raw, '1n2') || betEntry(raw, '12');
          if (!entry) return { ...m, odds: null };
          return {
            ...m,
            odds: {
              home: bestForOutcome(entry, ['1'], { allowed }),
              draw: bestForOutcome(entry, ['0'], { allowed }),
              away: bestForOutcome(entry, ['2'], { allowed })
            }
          };
        } catch (_) { return { ...m, odds: null }; }
      }));
      results.push(...settled);
    }
    return results;
  }

  /* ------------------------------------------------------------------
     Extraction de TOUS les marchés d'un match (avec vraies cotes FR)
     pour alimenter le Radar. Chaque option porte un id unique.
     ------------------------------------------------------------------ */
  const capTeam = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
  const thrLabel = (special) => String(special).replace('-', '.');

  async function getMatchMarkets(rencId, { allowed = null } = {}) {
    const raw = await getFullOdds(rencId);
    if (!raw) return null;
    const H = capTeam(raw.info?.teamDom?.equipeNom || 'Domicile');
    const A = capTeam(raw.info?.teamExt?.equipeNom || 'Extérieur');

    const opt = (arr, id, selection, o) => {
      if (!o || !(Number(o.cote) > 1)) return;
      const name = bookName(o.bookId);
      arr.push({ id, selection, cote: Number(o.cote), book: name, mine: !allowed || allowed.has(norm(name)) });
    };
    const markets = [];
    const add = (label, opts) => { if (opts.length) markets.push({ label, options: opts }); };

    for (const e of raw.odds) {
      const b = e.bestfr || e.best;
      if (!b) continue;
      const o = [];
      const s = e.special || '';

      if (e.typename === '1n2' && !s) {
        opt(o, '1n2_1', `Victoire ${H}`, b['1']); opt(o, '1n2_0', 'Match nul', b['0']); opt(o, '1n2_2', `Victoire ${A}`, b['2']);
        add(o.length > 2 ? 'Résultat (1N2)' : 'Vainqueur', o);
      } else if (e.typename === '12' && !s) {
        // Sports à 2 issues (tennis, basket, boxe, MMA, baseball…)
        opt(o, '12_1', `Victoire ${H}`, b['1']); opt(o, '12_2', `Victoire ${A}`, b['2']);
        add('Vainqueur', o);
      } else if (e.typename === 'DC') {
        opt(o, 'DC_1', `${H} ou Nul (double chance)`, b['1']); opt(o, 'DC_2', `Nul ou ${A} (double chance)`, b['2']); opt(o, 'DC_3', `${H} ou ${A} (double chance)`, b['3']);
        add('Double chance', o);
      } else if (e.typename === 'DNB') {
        opt(o, 'DNB_1', `${H} (remboursé si nul)`, b['1']); opt(o, 'DNB_2', `${A} (remboursé si nul)`, b['2']);
        add('Draw No Bet', o);
      } else if (e.typename === 'OU') {
        const t = thrLabel(s);
        opt(o, `OU${s}_3`, `Plus de ${t} buts`, b['3']); opt(o, `OU${s}_2`, `Moins de ${t} buts`, b['2']);
        add(`Total buts ${t}`, o);
      } else if (e.typename === 'HTOU') {
        const t = thrLabel(s);
        opt(o, `HTOU${s}_3`, `Plus de ${t} buts (1re MT)`, b['3']); opt(o, `HTOU${s}_2`, `Moins de ${t} buts (1re MT)`, b['2']);
        add(`Total buts 1re MT ${t}`, o);
      } else if (e.typename === 'HT') {
        opt(o, 'HT_1', `${H} à la mi-temps`, b['1']); opt(o, 'HT_2', 'Nul à la mi-temps', b['2']); opt(o, 'HT_3', `${A} à la mi-temps`, b['3']);
        add('Résultat 1re mi-temps (1N2)', o);
      } else if (e.typename === 'HT2') {
        opt(o, 'HT2_1', `${H} 2e mi-temps`, b['1']); opt(o, 'HT2_2', 'Nul 2e mi-temps', b['2']); opt(o, 'HT2_3', `${A} 2e mi-temps`, b['3']);
        add('Résultat 2e mi-temps (1N2)', o);
      } else if (e.typename === 'HTFT') {
        const c = { 1: `${H}/${H}`, 2: `${H}/Nul`, 3: `${H}/${A}`, 4: `Nul/${H}`, 5: 'Nul/Nul', 6: `Nul/${A}`, 7: `${A}/${H}`, 8: `${A}/Nul`, 9: `${A}/${A}` };
        for (const k of Object.keys(c)) opt(o, `HTFT_${k}`, `Mi-temps/Fin : ${c[k]}`, b[k]);
        add('Mi-temps / Fin de match', o);
      } else if (e.typename === '1n2' && s) {
        opt(o, `H1n2${s}_1`, `${H} handicap ${s}`, b['1']); opt(o, `H1n2${s}_0`, `Nul handicap ${s}`, b['0']); opt(o, `H1n2${s}_2`, `${A} handicap ${s}`, b['2']);
        add(`Handicap ${s}`, o);
      } else if (e.typename === '12' && s) {
        opt(o, `H12${s}_1`, `${H} handicap asiatique ${s}`, b['1']); opt(o, `H12${s}_2`, `${A} handicap asiatique ${s}`, b['2']);
        add(`Handicap asiatique ${s}`, o);
      }
      if (markets.length >= 16) break;
    }
    return { home: H, away: A, markets };
  }

  /** Retrouve le match coteur correspondant à un pari (renvoie {rencId, slug, teams, date}). */
  async function findMatch(pick) {
    const page = SPORT_PAGES[norm(pick.sport).split(' ')[0]];
    if (!page) return null;
    const matches = await getMatchList(page);
    if (!matches.length) return null;

    const parts = (pick.match || pick.event || '').split(/\s+[–—-]\s+|\s+vs\.?\s+/i);
    const A = toks(parts[0] || ''), B = toks(parts[1] || '');
    if (!A.length || !B.length) return null;

    const dISO = pick.date_match || pick.date;
    return matches.find((m) => {
      if (dISO && Math.abs(m.date - new Date(dISO + 'T12:00:00')) > 36 * 864e5) return false;
      return (teamMatch(A, m.teamA) && teamMatch(B, m.teamB)) || (teamMatch(A, m.teamB) && teamMatch(B, m.teamA));
    }) || null;
  }

  /** Score + statut en direct d'un match via son slug (backend requis). */
  async function liveScore(slug) {
    if (!slug) return null;
    try {
      const r = await fetch(`/api/coteur?type=score&slug=${encodeURIComponent(slug)}`);
      const j = await r.json();
      return j.ok ? j : null;
    } catch (_) { return null; }
  }

  async function test() {
    const html = await proxyFetch(`${COTEUR}/${SPORT_PAGES.football}`);
    const matches = parseMatchList(html);
    if (!matches.length) throw new Error('Aucun match récupéré — proxy CORS bloqué ou structure du site modifiée.');
    return matches.length;
  }

  return {
    verifyPick, getUpcomingEvents, getMatchMarkets, findMatch, liveScore, test, generateToken,
    // exposés pour tests
    _parseMatchList: parseMatchList, _bestForOutcome: bestForOutcome,
    _resolveOutcome: resolveOutcome, _betEntry: betEntry
  };
})();
