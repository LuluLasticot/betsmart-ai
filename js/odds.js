/* ==========================================================================
   BetSmart AI — Cotes en temps réel (The Odds API, région "fr")
   Bookmakers couverts : Winamax, Betclic, Unibet, PMU, NetBet.
   Utilisé pour vérifier au prix réel les picks du Radar et l'analyse de
   match : la value est recalculée sur la meilleure cote du marché.
   Économie de quota : /sports est gratuit ; les cotes d'un championnat
   sont mises en cache 10 minutes.
   ========================================================================== */
'use strict';

const Odds = (() => {
  const BASE = 'https://api.the-odds-api.com/v4';
  const BOOK_LABELS = {
    winamax_fr: 'Winamax', betclic_fr: 'Betclic', unibet_fr: 'Unibet',
    pmu_fr: 'PMU', netbet_fr: 'NetBet'
  };

  let sportsCache = null;          // { at, list }
  const oddsCache = new Map();     // sportKey -> { at, events }
  let quotaRemaining = null;

  /* ---- Normalisation de texte (accents, ponctuation) ---- */
  const norm = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'los', 'las', 'der', 'the', 'fc', 'cf', 'ac', 'as', 'sc', 'rc', 'og', 'fco', 'club', 'olympique', 'sporting', 'real', 'stade']);
  const tokens = (s) => norm(s).split(' ').filter((t) => t.length >= 2 && !STOP.has(t) || ['om', 'ol', 'psg'].includes(t));

  /** Initiales d'un nom d'équipe : "Paris Saint Germain" → "psg", "Olympique de Marseille" → "om"/"odm". */
  function initialsOf(teamName) {
    const words = norm(teamName).split(' ').filter(Boolean);
    const all = words.map((w) => w[0]).join('');
    const meaningful = words.filter((w) => !['de', 'du', 'des', 'le', 'la', 'les'].includes(w)).map((w) => w[0]).join('');
    return new Set([all, meaningful]);
  }

  /* ------------------------------------------------------------------
     1. Liste des championnats actifs (gratuit, cache 1 h)
     ------------------------------------------------------------------ */
  async function listSports(apiKey) {
    if (sportsCache && Date.now() - sportsCache.at < 3600e3) return sportsCache.list;
    const res = await fetch(`${BASE}/sports/?apiKey=${encodeURIComponent(apiKey)}`);
    if (!res.ok) throw new Error(res.status === 401 ? 'Clé The Odds API invalide.' : `The Odds API : erreur ${res.status}`);
    const list = await res.json();
    sportsCache = { at: Date.now(), list };
    return list;
  }

  /** Correspondances directes pour les compétitions les plus courantes. */
  const KNOWN = [
    [/ligue 1/, 'soccer_france_ligue_one'],
    [/ligue 2/, 'soccer_france_ligue_two'],
    [/premier league|angleterre/, 'soccer_epl'],
    [/liga(?!.*port)|espagne/, 'soccer_spain_la_liga'],
    [/serie a|italie/, 'soccer_italy_serie_a'],
    [/bundesliga|allemagne/, 'soccer_germany_bundesliga'],
    [/champions league|ligue des champions|ldc/, 'soccer_uefa_champs_league'],
    [/europa league|ligue europa/, 'soccer_uefa_europa_league'],
    [/conference/, 'soccer_uefa_europa_conference_league'],
    [/primeira|portugal/, 'soccer_portugal_primeira_liga'],
    [/eredivisie|pays bas/, 'soccer_netherlands_eredivisie'],
    [/nba/, 'basketball_nba'],
    [/euroleague|euroligue/, 'basketball_euroleague'],
    [/nhl/, 'icehockey_nhl'],
    [/mlb/, 'baseball_mlb'],
    [/nfl/, 'americanfootball_nfl'],
    [/top 14/, 'rugbyunion_top14']
  ];

  const GROUPS = {
    football: 'soccer', tennis: 'tennis', basketball: 'basketball', basket: 'basketball',
    rugby: 'rugby', hockey: 'ice hockey', mma: 'mixed martial arts', baseball: 'baseball',
    boxe: 'boxing'
  };

  /* ------------------------------------------------------------------
     2. Compétition → sport_key
     ------------------------------------------------------------------ */
  async function resolveSportKey(apiKey, sport, competition) {
    const comp = norm(competition);
    for (const [re, key] of KNOWN) if (re.test(comp)) return key;

    const list = await listSports(apiKey);
    const wantedGroup = GROUPS[norm(sport).split(' ')[0]] || null;
    const pool = wantedGroup ? list.filter((s) => norm(s.group).includes(wantedGroup)) : list;

    // Meilleur recouvrement de tokens entre la compétition et le titre du championnat
    let best = null, bestScore = 0;
    for (const s of pool) {
      const title = norm(`${s.title} ${s.description || ''}`);
      const score = tokens(competition).filter((t) => title.includes(t)).length;
      if (score > bestScore) { best = s; bestScore = score; }
    }
    return bestScore > 0 ? best.key : null;
  }

  /* ------------------------------------------------------------------
     3. Cotes d'un championnat (cache 10 min) — région fr, h2h + totals
     ------------------------------------------------------------------ */
  async function getEvents(apiKey, sportKey) {
    const cached = oddsCache.get(sportKey);
    if (cached && Date.now() - cached.at < 600e3) return cached.events;

    const url = `${BASE}/sports/${sportKey}/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=fr&markets=h2h,totals&oddsFormat=decimal`;
    const res = await fetch(url);
    quotaRemaining = res.headers.get('x-requests-remaining') ?? quotaRemaining;
    if (!res.ok) {
      if (res.status === 401) throw new Error('Clé The Odds API invalide.');
      if (res.status === 429) throw new Error('Quota The Odds API épuisé ce mois-ci.');
      if (res.status === 404 || res.status === 422) return []; // championnat hors saison
      throw new Error(`The Odds API : erreur ${res.status}`);
    }
    const events = await res.json();
    oddsCache.set(sportKey, { at: Date.now(), events });
    return events;
  }

  /* ------------------------------------------------------------------
     4. Retrouver l'événement (matching de noms d'équipes)
     ------------------------------------------------------------------ */
  function findEvent(events, matchStr, dateISO) {
    const sides = String(matchStr || '').split(/\s+[–—-]\s+|\s+vs\.?\s+|\s+contre\s+/i).map(tokens);
    if (sides.length < 2 || !sides[0].length || !sides[1].length) return null;

    const overlap = (a, evTeam) => {
      const t = norm(evTeam);
      const inits = initialsOf(evTeam);
      return a.some((tok) => (tok.length >= 3 && t.includes(tok)) || inits.has(tok));
    };

    let best = null, bestScore = 0;
    for (const ev of events) {
      if (dateISO && ev.commence_time && Math.abs(new Date(ev.commence_time) - new Date(dateISO + 'T12:00:00')) > 36 * 3600e3) continue;
      let score = 0;
      if (overlap(sides[0], ev.home_team) && overlap(sides[1], ev.away_team)) score = 2;
      else if (overlap(sides[0], ev.away_team) && overlap(sides[1], ev.home_team)) score = 2;
      else if (overlap([...sides[0], ...sides[1]], ev.home_team) || overlap([...sides[0], ...sides[1]], ev.away_team)) score = 1;
      if (score > bestScore) { best = ev; bestScore = score; }
    }
    return bestScore === 2 ? best : null; // exige les deux équipes pour éviter les faux positifs
  }

  /* ------------------------------------------------------------------
     5. Extraire les cotes du marché visé pour chaque book français
     ------------------------------------------------------------------ */
  function extractOdds(event, pick) {
    const sel = norm(pick.selection);
    const selRaw = String(pick.selection || '').toLowerCase();
    const threshold = (selRaw.match(/(\d+)[.,]5/) || [])[1];
    const isTotals = /\b(plus|moins|over|under)\b|buts?|points?/.test(sel) && threshold !== undefined;

    let marketKey, matchOutcome;
    if (isTotals) {
      marketKey = 'totals';
      const point = parseFloat(`${threshold}.5`);
      const dir = /plus|over/.test(sel) ? 'over' : 'under';
      matchOutcome = (o) => norm(o.name) === dir && (isNaN(point) || o.point === point);
    } else {
      marketKey = 'h2h';
      if (/\bnul\b|draw/.test(sel)) {
        matchOutcome = (o) => norm(o.name) === 'draw';
      } else {
        const selToks = tokens(pick.selection.replace(/victoire|gagne|vainqueur|win/gi, ''));
        matchOutcome = (o) => {
          const name = norm(o.name);
          const inits = initialsOf(o.name);
          return selToks.some((t) => (t.length >= 3 && name.includes(t)) || inits.has(t));
        };
      }
    }

    const prices = [];
    for (const bk of event.bookmakers || []) {
      const label = BOOK_LABELS[bk.key];
      if (!label) continue;
      const market = (bk.markets || []).find((m) => m.key === marketKey);
      if (!market) continue;
      const outcome = (market.outcomes || []).find(matchOutcome);
      if (outcome && typeof outcome.price === 'number') {
        prices.push({ book: label, price: outcome.price, point: outcome.point });
      }
    }
    if (!prices.length) return null;
    prices.sort((a, b) => b.price - a.price);
    return { prices, best: prices[0], market: marketKey };
  }

  /* ------------------------------------------------------------------
     API principale : vérifie un pick → cotes réelles des books FR
     ------------------------------------------------------------------ */
  async function verifyPick(apiKey, pick) {
    const sportKey = await resolveSportKey(apiKey, pick.sport, pick.competition || pick.sport);
    if (!sportKey) return { status: 'no_league' };
    const events = await getEvents(apiKey, sportKey);
    if (!events.length) return { status: 'no_events' };
    const event = findEvent(events, pick.match || pick.event, pick.date_match || pick.date);
    if (!event) return { status: 'no_match' };
    const odds = extractOdds(event, pick);
    if (!odds) return { status: 'no_market', event };
    return { status: 'ok', event, ...odds };
  }

  async function test(apiKey) {
    await listSports(apiKey);
    return true;
  }

  const quota = () => quotaRemaining;

  return { verifyPick, test, quota, listSports, findEvent, extractOdds };
})();
