/* ==========================================================================
   BetSmart AI — Scores en direct SANS IA
   Objectif : zéro appel Gemini pour une tâche purement mécanique.
   Deux sources, par ordre de préférence :
     1. coteur.com  — gratuit, déjà utilisé pour les cotes (score par match).
     2. api-sports  — clé de l'utilisateur, un seul appel « live » par sport
                      renvoie TOUS les matchs en cours ; on fait le rapprochement
                      par nom d'équipe. Bien plus économe qu'une requête par match.
   Résultats mis en cache 60 s. Aucun jeton, aucun coût de LLM.
   ========================================================================== */
'use strict';

const Scores = (() => {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'fc', 'cf', 'ac', 'as', 'sc', 'rc', 'club', 'olympique', 'sporting', 'real', 'stade', 'city', 'united']);
  const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));

  /** Les deux camps d'un libellé « A – B » / « A vs B ». */
  function sides(event) {
    const p = String(event || '').split(/\s+[–—-]\s+|\s+vs\.?\s+|\s+contre\s+/i);
    return p.length >= 2 ? [p[0].trim(), p.slice(1).join(' ').trim()] : [String(event || '').trim(), ''];
  }
  const sameTeam = (a, b) => {
    const ta = toks(a), tb = toks(b);
    if (!ta.length || !tb.length) return false;
    return ta.some((t) => tb.includes(t)) || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
  };

  /* ---- Sport (libellé FR) → clé api-sports ---- */
  const SPORT = {
    football: 'football', foot: 'football', soccer: 'football',
    basket: 'basketball', basketball: 'basketball',
    hockey: 'hockey', baseball: 'baseball', rugby: 'rugby',
    volley: 'volleyball', volleyball: 'volleyball', hand: 'handball', handball: 'handball'
  };
  const sportKey = (s) => SPORT[norm(s).split(' ')[0]] || null;

  /* ---- Cache des listes « live » par sport ---- */
  const cache = new Map(); // sportKey → { at, list }
  const TTL = 60000;

  async function liveList(sk, apiKey) {
    const c = cache.get(sk);
    if (c && Date.now() - c.at < TTL) return c.list;
    let list = [];
    try {
      const ep = sk === 'football' ? 'fixtures?live=all' : 'games?live=all';
      const r = await fetch(`/api/facts?ep=${encodeURIComponent(ep)}&key=${encodeURIComponent(apiKey)}&sp=${encodeURIComponent(sk)}`);
      const j = await r.json();
      list = (j && j.ok && Array.isArray(j.response)) ? j.response : [];
    } catch (_) { list = []; }
    cache.set(sk, { at: Date.now(), list });
    return list;
  }

  const num = (v) => (v == null ? null : (typeof v === 'object' ? (v.total ?? v.points ?? v.score ?? null) : v));

  /** Normalise une entrée api-sports (football v3 ou sports d'équipe v1). */
  function readEntry(e, sk) {
    if (sk === 'football') {
      const st = e.fixture?.status || {};
      const fin = ['FT', 'AET', 'PEN'].includes(st.short);
      return {
        home: e.teams?.home?.name, away: e.teams?.away?.name,
        sd: e.goals?.home ?? null, se: e.goals?.away ?? null,
        finished: fin,
        live: ['1H', '2H', 'ET', 'P', 'LIVE'].includes(st.short),
        half: st.short === 'HT',
        minute: st.elapsed != null ? `${st.elapsed}'` : null
      };
    }
    const s = e.status || {};
    const short = String(s.short || '').toUpperCase();
    return {
      home: e.teams?.home?.name, away: e.teams?.away?.name,
      sd: num(e.scores?.home), se: num(e.scores?.away),
      finished: ['FT', 'AOT', 'END', 'AET'].includes(short),
      live: !['NS', 'FT', 'AOT', 'END', 'POST', 'CANC'].includes(short),
      half: short === 'HT',
      minute: s.timer != null ? String(s.timer) : (s.long || null)
    };
  }

  /**
   * Scores des paris fournis, sans aucun appel à un LLM.
   * @returns Map(betId → { phase:'live'|'finished', score, min })
   */
  async function forBets(bets, { apiFootballKey } = {}) {
    const out = new Map();
    if (!bets || !bets.length) return out;

    // 1) coteur (gratuit) — score exact par match retrouvé
    const rest = [];
    await Promise.all(bets.map(async (b) => {
      try {
        const cm = await Coteur.findMatch(b);
        if (cm && cm.slug) {
          const s = await Coteur.liveScore(cm.slug);
          if (s && (s.score_dom !== null || s.status)) {
            const st = (s.status || '').replace(/EN DIRECT\s*[•·]?\s*/i, '').trim();
            out.set(String(b.id), s.finished
              ? { phase: 'finished', score: `${s.score_dom ?? 0}–${s.score_ext ?? 0}`, min: 'Fin', source: 'coteur' }
              : { phase: 'live', score: `${s.score_dom ?? 0}–${s.score_ext ?? 0}`, min: st || null, source: 'coteur' });
            return;
          }
        }
      } catch (_) {}
      rest.push(b);
    }));

    // 2) api-sports : UN appel « live » par sport, puis rapprochement par équipes
    if (!apiFootballKey || !rest.length) return out;
    const bySport = new Map();
    for (const b of rest) {
      const sk = sportKey(b.sport);
      if (!sk) continue;
      (bySport.get(sk) || bySport.set(sk, []).get(sk)).push(b);
    }
    for (const [sk, list] of bySport) {
      const live = await liveList(sk, apiFootballKey);
      if (!live.length) continue;
      for (const b of list) {
        const [h, a] = sides(b.event);
        const hit = live.map((e) => readEntry(e, sk)).find((e) =>
          (sameTeam(h, e.home) && sameTeam(a, e.away)) || (sameTeam(h, e.away) && sameTeam(a, e.home)));
        if (!hit) continue;
        out.set(String(b.id), {
          phase: hit.finished ? 'finished' : 'live',
          score: `${hit.sd ?? 0}–${hit.se ?? 0}`,
          min: hit.finished ? 'Fin' : (hit.half ? 'MT' : hit.minute),
          source: 'api-sports'
        });
      }
    }
    return out;
  }

  return { forBets, sides, sameTeam, sportKey };
})();
