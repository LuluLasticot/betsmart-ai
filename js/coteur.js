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

  const SPORT_PAGES = {
    football: 'cotes-foot', foot: 'cotes-foot',
    tennis: 'cotes-tennis',
    basketball: 'cotes-basket', basket: 'cotes-basket',
    rugby: 'cotes-rugby',
    handball: 'cotes-handball',
    volley: 'cotes-volley', volleyball: 'cotes-volley',
    hockey: 'cotes-hockey'
  };

  // ID bookmaker coteur → nom lisible (étendre au besoin)
  const BOOK_NAMES = {
    21: 'bet365', 22: 'Winamax', 23: 'Betway', 24: 'Betclic', 25: 'Unibet',
    33: 'Unibet BE', 36: '1xBet', 37: 'PMU', 43: 'Betsson', 44: 'Bwin', 45: 'Pinnacle',
    26: 'ParionsSport', 27: 'Zebet', 28: 'Genybet', 29: 'Vbet', 30: 'Olybet', 41: 'Feelingbet'
  };
  // Books français prioritaires pour la value
  const FR_BOOKS = new Set(['Winamax', 'Betclic', 'Unibet', 'PMU', 'ParionsSport', 'Zebet', 'Genybet', 'Vbet', 'Olybet', 'Bwin', 'Betsson']);

  let quotaNote = null;
  const listCache = new Map();   // sport -> { at, matches }
  const oddsCache = new Map();   // rencId -> { at, data }

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
        out.push({ rencId, teamA, teamB, league, date: parseCoteurDate(dm[1]) });
      } catch (_) { /* ignore */ }
    });
    return out;
  }

  async function getMatchList(sportPage) {
    const cached = listCache.get(sportPage);
    if (cached && Date.now() - cached.at < 300e3) return cached.matches;
    const html = await proxyFetch(`${COTEUR}/${sportPage}`);
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

    const token = generateToken();
    const target = `${ODDS_API}/${rencId}?token=${encodeURIComponent(token)}`;
    const body = await proxyFetch(target, { timeout: 9000 });
    let raw = null;
    try { raw = JSON.parse(body); } catch (_) { return null; }
    if (raw?.success === false || !Array.isArray(raw?.odds)) return null;
    oddsCache.set(rencId, { at: Date.now(), data: raw });
    return raw;
  }

  /* ------------------------------------------------------------------
     Extraction des cotes par bookmaker pour un type de pari
     Réponse coteur : odds[] avec { typename, bestfr:{outcome:{bookId,cote}},
     best:{...}, et éventuellement une liste complète par book }
     ------------------------------------------------------------------ */
  function betEntry(raw, typenames) {
    for (const tn of typenames) {
      const e = raw.odds.find((o) => o.typename === tn);
      if (e) return e;
    }
    return null;
  }

  /** Cotes par book pour un outcome donné ('1','N','2', ou 'over'/'under'). */
  function pricesForOutcome(entry, outcomeKeys) {
    const prices = [];
    const seen = new Set();

    const push = (bookId, cote) => {
      const v = parseFloat(String(cote));
      const name = BOOK_NAMES[bookId] || `#${bookId}`;
      if (!(v > 1) || seen.has(name)) return;
      seen.add(name);
      prices.push({ book: name, price: v, fr: FR_BOOKS.has(name) });
    };

    // 1) Structure complète par book si présente (odds/cotes/bookmakers)
    const fullList = entry.cotes || entry.bookmakers || entry.all || null;
    if (Array.isArray(fullList)) {
      for (const b of fullList) {
        const bookId = b.bookId ?? b.id;
        for (const k of outcomeKeys) {
          const c = b[k] ?? b.cotes?.[k] ?? b.odds?.[k];
          if (c) { push(bookId, c); break; }
        }
      }
    }

    // 2) Repli sur bestfr / best (meilleur book par outcome) — chemin éprouvé
    if (!prices.length) {
      const best = entry.bestfr || entry.best || {};
      for (const k of outcomeKeys) {
        if (best[k]?.bookId && best[k]?.cote) push(best[k].bookId, best[k].cote);
      }
    }

    prices.sort((a, b) => b.price - a.price);
    return prices;
  }

  /** Détermine l'outcome coteur ciblé par la sélection du pick. */
  function resolveOutcome(pick, match) {
    const sel = norm(pick.selection);
    // Over / Under
    const thr = (String(pick.selection || '').match(/(\d+)[.,]5/) || [])[1];
    if (thr && /\b(plus|moins|over|under)\b|but|point/.test(sel)) {
      const dir = /plus|over/.test(sel) ? 'over' : 'under';
      return { market: 'ou', threshold: `${thr}.5`, keys: [dir, dir === 'over' ? '+' : '-'] };
    }
    // Nul
    if (/\bnul\b|draw|match nul/.test(sel)) return { market: '1n2', keys: ['N', '0'] };
    // Victoire équipe → home (1) ou away (2)
    const selToks = toks(pick.selection.replace(/victoire|gagnant|vainqueur|gagne|win/gi, ''));
    if (match && teamMatch(selToks, match.teamA)) return { market: '1n2', keys: ['1'] };
    if (match && teamMatch(selToks, match.teamB)) return { market: '1n2', keys: ['2'] };
    // Par défaut : côté 1
    return { market: '1n2', keys: ['1'] };
  }

  /* ------------------------------------------------------------------
     API publique
     ------------------------------------------------------------------ */

  /** Vérifie un pick → cotes réelles par book (interface compatible Odds). */
  async function verifyPick(_key, pick) {
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
    const entry = target.market === 'ou'
      ? betEntry(raw, [`+/-${target.threshold}`, `ou${target.threshold}`, 'ou', `+/- ${target.threshold}`])
      : betEntry(raw, ['1n2', '12']);
    if (!entry) return { status: 'no_market', event: found };

    const prices = pricesForOutcome(entry, target.keys);
    if (!prices.length) return { status: 'no_market', event: found };

    // Priorité aux books français pour "best"
    const frPrices = prices.filter((p) => p.fr);
    const best = (frPrices[0] || prices[0]);
    return { status: 'ok', event: found, prices: frPrices.length ? frPrices : prices, best, market: target.market, source: 'coteur' };
  }

  /** Liste des prochains matchs d'un sport avec meilleures cotes 1N2 (comparateur). */
  async function getUpcomingEvents(sport, { limit = 20, withOdds = true, concurrency = 3 } = {}) {
    const page = SPORT_PAGES[norm(sport).split(' ')[0]] || SPORT_PAGES.football;
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
          const entry = betEntry(raw, ['1n2', '12']);
          if (!entry) return { ...m, odds: null };
          return {
            ...m,
            odds: {
              home: pricesForOutcome(entry, ['1'])[0] || null,
              draw: pricesForOutcome(entry, ['N', '0'])[0] || null,
              away: pricesForOutcome(entry, ['2'])[0] || null
            }
          };
        } catch (_) { return { ...m, odds: null }; }
      }));
      results.push(...settled);
    }
    return results;
  }

  async function test() {
    const html = await proxyFetch(`${COTEUR}/${SPORT_PAGES.football}`);
    const matches = parseMatchList(html);
    if (!matches.length) throw new Error('Aucun match récupéré — proxy CORS bloqué ou structure du site modifiée.');
    return matches.length;
  }

  return {
    verifyPick, getUpcomingEvents, test, generateToken,
    // exposés pour tests
    _parseMatchList: parseMatchList, _pricesForOutcome: pricesForOutcome,
    _resolveOutcome: resolveOutcome, _betEntry: betEntry
  };
})();
