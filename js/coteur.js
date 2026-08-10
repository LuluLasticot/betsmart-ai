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
    badminton: 'cotes-badminton',
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

  // Titre-case (les équipes arrivent en MAJUSCULES : "AALESUND - MOLDE")
  const titleCase = (s) => String(s || '').toLowerCase()
    .replace(/(^|[\s\-'/])([a-zà-ÿ])/g, (_, sep, c) => sep + c.toUpperCase());

  /**
   * Parsing de la page liste. Coteur porte désormais les métadonnées du match
   * en attributs sur les boutons de cote : data-rencid, data-eventname
   * ("DOM - EXT"), data-eventdate (timestamp Unix, secondes). Beaucoup plus
   * robuste que l'ancien parsing du texte à plat. L'ancien format reste en repli.
   */
  function parseMatchList(html) {
    const out = [];
    if (!html) return out;
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const seen = new Set();
    doc.querySelectorAll('[data-rencid][data-eventname][data-eventdate]').forEach((el) => {
      try {
        const rencId = el.getAttribute('data-rencid');
        if (!rencId || seen.has(rencId)) return;
        const name = (el.getAttribute('data-eventname') || '').replace(/\s+/g, ' ').trim();
        const ts = Number(el.getAttribute('data-eventdate'));
        if (!name || !ts) return;
        const parts = name.split(/\s+[-–—]\s+/);
        if (parts.length < 2) return;
        const teamA = titleCase(parts[0].trim());
        const teamB = titleCase(parts.slice(1).join(' - ').trim());
        if (!teamA || !teamB) return;
        const date = new Date(ts * 1000);
        // Lien (slug) + ligue depuis l'ancre correspondante, si présente
        const a = doc.querySelector(`a[href^="/cote/"][href*="-${rencId}"]`);
        const slug = a ? ((a.getAttribute('href') || '').match(/\/cote\/([a-z0-9-]+)/i) || [])[1] || null : null;
        let league = 'Coteur';
        if (a) {
          const lg = a.querySelector('.text-muted, .small');
          const t = lg ? (lg.textContent || '').replace(/\s+/g, ' ').trim() : '';
          if (t) league = t;
        }
        seen.add(rencId);
        out.push({ rencId, slug, teamA, teamB, league, date });
      } catch (_) { /* ignore */ }
    });
    if (out.length) return out;

    // Repli : ancien format à plat ("DD/MM HH:MM TeamA vs TeamB")
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

  async function fetchListPage(sportPage, page) {
    let html = '';
    if (await hasBackend()) {
      try {
        const r = await fetch(`/api/coteur?type=list&page=${encodeURIComponent(sportPage)}${page > 1 ? `&p=${page}` : ''}`);
        const j = await r.json();
        html = j.ok ? j.html : '';
      } catch (_) { /* repli proxies */ }
    }
    if (!html) html = await proxyFetch(`${COTEUR}/${sportPage}${page > 1 ? `?page=${page}` : ''}`);
    return parseMatchList(html);
  }

  /** Liste des matchs d'un sport. coteur pagine par ~15 matchs : on parcourt
      plusieurs pages pour ne pas manquer les rencontres imminentes. */
  async function getMatchList(sportPage, { pages = 4 } = {}) {
    const ck = `${sportPage}|${pages}`;
    const cached = listCache.get(ck);
    if (cached && Date.now() - cached.at < 300e3) return cached.matches;

    const all = [];
    const seen = new Set();
    for (let p = 1; p <= pages; p++) {
      let batch = [];
      try { batch = await fetchListPage(sportPage, p); } catch (_) { break; }
      if (!batch.length) break;                       // plus de résultats
      let added = 0;
      for (const m of batch) {
        const key = String(m.rencId || `${m.teamA}|${m.teamB}|${m.date}`);
        if (seen.has(key)) continue;
        seen.add(key); all.push(m); added++;
      }
      if (!added) break;                              // page identique → fin
    }
    listCache.set(ck, { at: Date.now(), matches: all });
    return all;
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

  /** Détermine le marché + issue coteur ciblés par la sélection du pick.
      Renvoie { typename, keys, special? } ou null si le marché n'est pas résoluble
      de façon fiable (dans ce cas on NE remplace PAS la cote → pas de valeur fausse). */
  function resolveOutcome(pick, match) {
    const sel = norm(pick.selection);
    const mk = norm(pick.marche);
    const selToks = toks(String(pick.selection || '').replace(/victoire|gagnant|vainqueur|gagne|win|rembours\w*|remb\.?|si nul/gi, ''));
    const isHome = !!(match && teamMatch(selToks, match.teamA));
    const isAway = !!(match && teamMatch(selToks, match.teamB));
    const hasDraw = /\bnul\b|\bdraw\b|match nul/.test(sel);

    // Over / Under (buts/points) : special = seuil encodé, over='3', under='2'
    const thrRaw = (String(pick.selection || '').match(/(\d+(?:[.,]\d)?)/) || [])[1];
    if (thrRaw && !/handicap/.test(mk) && (/\b(plus|moins|over|under)\b/.test(sel) || /total|but|point|over|under/.test(mk))) {
      const thr = thrRaw.replace(',', '.');
      const over = /plus|over/.test(sel);
      const half = /mi-?temps|1re|1ere|\bht\b|1ère/.test(mk);
      return { typename: half ? 'HTOU' : 'OU', special: encodeThreshold(thr), keys: [over ? '3' : '2'] };
    }

    // Handicap : l'encodage coteur (spécial signé, lignes multiples) est trop ambigu
    // pour un mapping fiable → on NE remplace PAS la cote (elle restera « non vérifiée »).
    if (/handicap|\+\d|[-−]\s?\d.*(pt|jeu|but|point)/.test(mk) || /handicap/.test(sel)) return null;

    // Double chance ('1'=1X domicile ou nul, '2'=X2 nul ou extérieur, '3'=12 domicile ou extérieur)
    if (/double chance/.test(mk) || (/\bou\b/.test(sel) && (hasDraw || (isHome && isAway)))) {
      if (hasDraw && isHome) return { typename: 'DC', keys: ['1'] };
      if (hasDraw && isAway) return { typename: 'DC', keys: ['2'] };
      if (isHome && isAway) return { typename: 'DC', keys: ['3'] };
    }

    // Draw No Bet (remboursé si nul)
    if (/draw no bet|\bdnb\b|remb/.test(mk) || /remb/.test(sel)) {
      if (isAway && !isHome) return { typename: 'DNB', keys: ['2'] };
      if (isHome) return { typename: 'DNB', keys: ['1'] };
    }

    // Résultat sec 1N2 (ou repli quand le libellé est absent)
    if (/1n2|1x2|resultat|vainqueur|match sec|\bmt\b/.test(mk) || !mk || /1n2/.test(mk)) {
      if (hasDraw) return { typename: '1n2', keys: ['0'] };
      if (isAway && !isHome) return { typename: '1n2', keys: ['2'] };
      if (isHome) return { typename: '1n2', keys: ['1'] };
    }

    // Dernier repli sur des indices d'issue clairs
    if (hasDraw) return { typename: '1n2', keys: ['0'] };
    if (isAway && !isHome) return { typename: '1n2', keys: ['2'] };
    if (isHome && !isAway) return { typename: '1n2', keys: ['1'] };

    return null; // marché non identifié → ne pas remplacer la cote (évite les valeurs aberrantes)
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
    if (!target) return { status: 'no_market', event: found }; // marché non résolu → on garde la cote d'origine
    const entry = target.special !== undefined
      ? betEntry(raw, target.typename, target.special)
      : (betEntry(raw, target.typename) || (target.typename === '1n2' ? betEntry(raw, '12') : null));
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
    // Seuls les matchs À VENIR : un match déjà commencé n'est plus pariable
    // et occupe inutilement la liste. Marge de 2 min pour l'imminent.
    const matches = (await getMatchList(page))
      .filter((m) => m.date.getTime() > Date.now() + 2 * 60e3)
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

    const markets = [];

    // Dévigorisation : probabilités « justes » à partir de la meilleure ligne
    // globale (best, qui intègre les books sharp type Pinnacle) sur toutes
    // les issues du marché → référence de marché sans marge.
    //
    // Méthode PUISSANCE plutôt que proportionnelle. La méthode proportionnelle
    // (diviser chaque probabilité implicite par leur somme) retire la même
    // fraction de marge à toutes les issues, ce qui est faux : les books
    // chargent nettement plus de marge sur les outsiders que sur les favoris
    // (biais favori-outsider, largement documenté). Résultat, elle surestime
    // les probabilités des outsiders et fabrique de la value fantôme sur les
    // grosses cotes — exactement le profil de paris qui a le plus perdu.
    //
    // La méthode puissance cherche l'exposant k tel que Σ (1/cote_i)^k = 1.
    // Comme k > 1, elle comprime davantage les petites probabilités.
    const devigPower = (imps) => {
      const vals = Object.values(imps);
      const sum = vals.reduce((a, b) => a + b, 0);
      if (!(sum > 0)) return null;
      // Marge quasi nulle (ligne composite entre books) : rien à corriger.
      if (Math.abs(sum - 1) < 1e-4) return { ...imps };
      const total = (k) => vals.reduce((a, p) => a + Math.pow(p, k), 0);
      let lo = 0.5, hi = 3;
      // La somme décroît quand k croît : on encadre puis on bissecte.
      if (total(lo) < 1) return null;
      let guard = 0;
      while (total(hi) > 1 && hi < 12 && guard++ < 30) hi *= 1.5;
      if (total(hi) > 1) return null;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (total(mid) > 1) lo = mid; else hi = mid;
      }
      const k = (lo + hi) / 2;
      const out = {};
      let norm = 0;
      for (const [key, p] of Object.entries(imps)) { out[key] = Math.pow(p, k); norm += out[key]; }
      // Renormalisation de sécurité (la bissection laisse une erreur résiduelle)
      for (const key of Object.keys(out)) out[key] /= norm;
      return out;
    };

    const devig = (src, keys) => {
      const imp = {}; let sum = 0;
      for (const k of keys) {
        const o = src?.[k];
        if (o && Number(o.cote) > 1) { imp[k] = 1 / Number(o.cote); sum += imp[k]; }
      }
      if (sum <= 0) return {};
      // Repli proportionnel si la résolution numérique échoue (marché à une
      // seule issue cotée, données aberrantes…).
      const pow = Object.keys(imp).length >= 2 ? devigPower(imp) : null;
      if (pow) return pow;
      const fair = {};
      for (const k of Object.keys(imp)) fair[k] = imp[k] / sum;
      return fair;
    };

    /** Construit un marché : outs = [[key, selection], …]. Cote = meilleur FR,
        proba juste + edge = dévig de la ligne globale (sharp). */
    const build = (e, label, prefix, outs) => {
      const fr = e.bestfr || e.best || {};
      const sharp = e.best || e.bestfr || {};
      const keys = outs.map((x) => x[0]);
      const fair = devig(sharp, keys);
      const options = [];
      for (const [k, selection] of outs) {
        const o = fr[k];
        if (!o || !(Number(o.cote) > 1)) continue;
        const cote = Number(o.cote);
        const name = bookName(o.bookId);
        const fp = fair[k] ?? null;
        options.push({
          id: `${prefix}_${k}`, selection, cote, book: name,
          mine: !allowed || allowed.has(norm(name)),
          fairProb: fp,
          marketEdge: fp != null ? Math.round((cote * fp - 1) * 1000) / 10 : null
        });
      }
      if (options.length) markets.push({ label, options, trj: e.retourfr != null ? Math.round(e.retourfr * 10) / 10 : null });
    };

    for (const e of raw.odds) {
      if (!(e.bestfr || e.best)) continue;
      const s = e.special || '';
      const t = thrLabel(s);

      if (e.typename === '1n2' && !s) build(e, (e.best && e.best['0']) ? 'Résultat (1N2)' : 'Vainqueur', '1n2', [['1', `Victoire ${H}`], ['0', 'Match nul'], ['2', `Victoire ${A}`]]);
      else if (e.typename === '12' && !s) build(e, 'Vainqueur', '12', [['1', `Victoire ${H}`], ['2', `Victoire ${A}`]]);
      else if (e.typename === 'DC') build(e, 'Double chance', 'DC', [['1', `${H} ou Nul`], ['2', `Nul ou ${A}`], ['3', `${H} ou ${A}`]]);
      else if (e.typename === 'DNB') build(e, 'Draw No Bet', 'DNB', [['1', `${H} (remb. si nul)`], ['2', `${A} (remb. si nul)`]]);
      else if (e.typename === 'OU') build(e, `Total buts ${t}`, `OU${s}`, [['3', `Plus de ${t} buts`], ['2', `Moins de ${t} buts`]]);
      else if (e.typename === 'HTOU') build(e, `Total buts 1re MT ${t}`, `HTOU${s}`, [['3', `Plus de ${t} buts (1re MT)`], ['2', `Moins de ${t} buts (1re MT)`]]);
      else if (e.typename === 'HT') build(e, 'Résultat 1re mi-temps (1N2)', 'HT', [['1', `${H} à la mi-temps`], ['2', 'Nul à la mi-temps'], ['3', `${A} à la mi-temps`]]);
      else if (e.typename === 'HT2') build(e, 'Résultat 2e mi-temps (1N2)', 'HT2', [['1', `${H} 2e mi-temps`], ['2', 'Nul 2e mi-temps'], ['3', `${A} 2e mi-temps`]]);
      else if (e.typename === 'HTFT') build(e, 'Mi-temps / Fin de match', 'HTFT', [['1', `Mi-temps/Fin : ${H}/${H}`], ['2', `Mi-temps/Fin : ${H}/Nul`], ['3', `Mi-temps/Fin : ${H}/${A}`], ['4', `Mi-temps/Fin : Nul/${H}`], ['5', 'Mi-temps/Fin : Nul/Nul'], ['6', `Mi-temps/Fin : Nul/${A}`], ['7', `Mi-temps/Fin : ${A}/${H}`], ['8', `Mi-temps/Fin : ${A}/Nul`], ['9', `Mi-temps/Fin : ${A}/${A}`]]);
      else if (e.typename === '1n2' && s) build(e, `Handicap ${s}`, `H1n2${s}`, [['1', `${H} handicap ${s}`], ['0', `Nul handicap ${s}`], ['2', `${A} handicap ${s}`]]);
      else if (e.typename === '12' && s) build(e, `Handicap asiatique ${s}`, `H12${s}`, [['1', `${H} handicap asiatique ${s}`], ['2', `${A} handicap asiatique ${s}`]]);

      if (markets.length >= 16) break;
    }
    return { home: H, away: A, markets };
  }

  /** Cliché actuel (cote + proba juste) d'une option précise — pour la CLV. */
  async function optionSnapshot(rencId, optionId) {
    const mk = await getMatchMarkets(rencId);
    if (!mk) return null;
    for (const market of mk.markets) {
      const o = market.options.find((x) => x.id === optionId);
      if (o) return { cote: o.cote, fairProb: o.fairProb, book: o.book };
    }
    return null;
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
    verifyPick, getUpcomingEvents, getMatchMarkets, optionSnapshot, findMatch, liveScore, test, generateToken,
    // exposés pour tests
    _parseMatchList: parseMatchList, _bestForOutcome: bestForOutcome,
    _resolveOutcome: resolveOutcome, _betEntry: betEntry
  };
})();
