/* ==========================================================================
   BetSmart AI — Faits réels du match via API-Football (api-sports.io)
   Source FIABLE (clé API → pas de blocage d'IP) pour que le Radar cesse
   d'inventer : forme récente, buts, xG (Expected Goals), H2H, classement.
   Football uniquement. Tout est défensif : en cas d'échec on renvoie ce qu'on a
   (ou null) et l'analyse retombe sur la recherche groundée.
   ========================================================================== */
'use strict';

const Facts = (() => {
  const cache = new Map();
  const norm = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'fc', 'cf', 'ac', 'as', 'sc', 'rc', 'if', 'sk', 'bk', 'fk', 'sv', 'us', 'cd', 'ca', 'club']);
  const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
  const nameMatch = (a, b) => { const nb = norm(b); return toks(a).some((t) => nb.includes(t)) || toks(b).some((t) => norm(a).includes(t)); };

  function isFootball(sport) {
    const s = norm(sport).split(' ')[0];
    return !s || s === 'football' || s === 'foot' || s === 'soccer';
  }

  // Sélections nationales : coteur donne le nom FR, API-Football l'attend en anglais.
  const COUNTRY_FR_EN = {
    espagne: 'Spain', allemagne: 'Germany', angleterre: 'England', 'pays bas': 'Netherlands',
    hollande: 'Netherlands', belgique: 'Belgium', italie: 'Italy', croatie: 'Croatia',
    'bresil': 'Brazil', argentine: 'Argentina', portugal: 'Portugal', maroc: 'Morocco',
    suisse: 'Switzerland', 'etats unis': 'USA', danemark: 'Denmark', suede: 'Sweden',
    norvege: 'Norway', pologne: 'Poland', 'republique tcheque': 'Czech-Republic',
    autriche: 'Austria', turquie: 'Turkey', grece: 'Greece', ecosse: 'Scotland',
    'pays de galles': 'Wales', irlande: 'Ireland', serbie: 'Serbia', 'coree du sud': 'South-Korea',
    japon: 'Japan', mexique: 'Mexico', uruguay: 'Uruguay', colombie: 'Colombia',
    'cote d ivoire': 'Ivory-Coast', senegal: 'Senegal', nigeria: 'Nigeria', 'egypte': 'Egypt',
    tunisie: 'Tunisia', algerie: 'Algeria', cameroun: 'Cameroon', ghana: 'Ghana', france: 'France'
  };
  const enName = (name) => COUNTRY_FR_EN[norm(name)] || name;

  let lastError = null;

  async function call(ep, key) {
    const ck = ep;
    const c = cache.get(ck);
    if (c && Date.now() - c.at < 600000) return c.data;
    try {
      const r = await fetch(`/api/facts?ep=${encodeURIComponent(ep)}&key=${encodeURIComponent(key)}`);
      const j = await r.json();
      if (j && !j.ok && j.error) lastError = j.error;
      const data = j && j.ok ? j.response : null;
      cache.set(ck, { at: Date.now(), data });
      return data;
    } catch (e) { lastError = String((e && e.message) || e); return null; }
  }

  async function findTeam(name, key) {
    // Essaie le nom tel quel, puis la traduction anglaise (sélections nationales)
    for (const q of [name, enName(name)].filter((v, i, a) => v && a.indexOf(v) === i)) {
      const res = await call(`teams?search=${encodeURIComponent(q)}`, key);
      if (res && res.length) {
        const teams = res.map((x) => x.team).filter(Boolean);
        const exact = teams.find((t) => nameMatch(q, t.name));
        const t = exact || teams[0];
        if (t) return { id: t.id, name: t.name };
      }
    }
    return null;
  }

  const FIN = new Set(['FT', 'AET', 'PEN']);
  function outcome(fx, teamId) {
    const isHome = fx.teams.home.id === teamId;
    const hw = fx.teams.home.winner === true, aw = fx.teams.away.winner === true;
    if (!hw && !aw) return 'draw';
    return (isHome && hw) || (!isHome && aw) ? 'won' : 'lost';
  }
  const RES = { won: 'V', lost: 'D', draw: 'N' };

  /** Forme récente : n derniers matchs terminés (+ xG best-effort sur les 3 derniers). */
  async function recentForm(teamId, key, n = 6, xgOn = true) {
    const res = await call(`fixtures?team=${teamId}&last=${n}`, key);
    if (!res || !res.length) return null;
    const fins = res.filter((fx) => FIN.has(fx.fixture.status.short)).reverse(); // récent d'abord
    let w = 0, l = 0, dr = 0, gf = 0, ga = 0;
    const recent = fins.map((fx) => {
      const isHome = fx.teams.home.id === teamId;
      const g = isHome ? fx.goals.home : fx.goals.away;
      const gc = isHome ? fx.goals.away : fx.goals.home;
      gf += g || 0; ga += gc || 0;
      const r = outcome(fx, teamId);
      if (r === 'won') w++; else if (r === 'lost') l++; else dr++;
      return {
        id: fx.fixture.id, opp: isHome ? fx.teams.away.name : fx.teams.home.name,
        score: `${g}-${gc}`, res: RES[r], home: isHome, date: (fx.fixture.date || '').slice(0, 10)
      };
    });
    if (!recent.length) return null;

    let xgFor = null, xgAg = null;
    if (xgOn) {
      const sample = recent.slice(0, 3);
      const stats = await Promise.all(sample.map((m) => call(`fixtures/statistics?fixture=${m.id}`, key)));
      let sf = 0, sa = 0, cnt = 0;
      stats.forEach((st) => {
        if (!Array.isArray(st) || st.length < 2) return;
        const mine = st.find((e) => e.team && e.team.id === teamId);
        const opp = st.find((e) => e.team && e.team.id !== teamId);
        const xg = (e) => { const it = (e && e.statistics || []).find((s) => /expected_goals|expected goals/i.test(s.type)); const v = it ? parseFloat(it.value) : NaN; return isNaN(v) ? null : v; };
        const f = xg(mine), a = xg(opp);
        if (f != null && a != null) { sf += f; sa += a; cnt++; }
      });
      if (cnt) { xgFor = Math.round(sf / cnt * 100) / 100; xgAg = Math.round(sa / cnt * 100) / 100; }
    }

    return { played: recent.length, w, d: dr, l, gf, ga, streak: recent.map((x) => x.res).join(' '), recent, xgFor, xgAg };
  }

  /** Rencontre à venir → league + season (pour le classement). */
  async function nextFixtureLeague(teamId, opponentName, key) {
    const res = await call(`fixtures?team=${teamId}&next=5`, key);
    if (!res || !res.length) return null;
    const hit = res.find((fx) => {
      const opp = fx.teams.home.id === teamId ? fx.teams.away.name : fx.teams.home.name;
      return nameMatch(opponentName, opp);
    }) || res[0];
    return { leagueId: hit.league.id, season: hit.league.season, leagueName: hit.league.name };
  }

  async function h2h(id1, id2, key) {
    const res = await call(`fixtures/headtohead?h2h=${id1}-${id2}&last=8`, key);
    if (!res || !res.length) return null;
    let w1 = 0, w2 = 0, dr = 0;
    res.filter((fx) => FIN.has(fx.fixture.status.short)).forEach((fx) => {
      const hw = fx.teams.home.winner === true, aw = fx.teams.away.winner === true;
      const homeIs1 = fx.teams.home.id === id1;
      if (!hw && !aw) dr++;
      else if ((hw && homeIs1) || (aw && !homeIs1)) w1++; else w2++;
    });
    return { t1Wins: w1, draws: dr, t2Wins: w2, n: w1 + w2 + dr };
  }

  async function standing(leagueId, season, teamId, key) {
    const res = await call(`standings?league=${leagueId}&season=${season}`, key);
    try {
      const table = res[0].league.standings.flat();
      const row = table.find((r) => r.team && r.team.id === teamId);
      if (!row) return null;
      return { position: row.rank, points: row.points, played: row.all && row.all.played, total: table.length, form: row.form || null };
    } catch (_) { return null; }
  }

  /** Faits complets d'un match + bloc texte pour le prompt. */
  async function matchFacts({ home, away, sport, apiKey }) {
    if (!apiKey || !home || !away || !isFootball(sport)) return null;
    lastError = null;
    try {
      const [ht, at] = await Promise.all([findTeam(home, apiKey), findTeam(away, apiKey)]);
      if (!ht && !at) return { noData: true, reason: lastError || 'équipes introuvables dans API-Football' };

      const [hForm, aForm, lg] = await Promise.all([
        ht ? recentForm(ht.id, apiKey) : null,
        at ? recentForm(at.id, apiKey) : null,
        ht && at ? nextFixtureLeague(ht.id, away, apiKey) : null
      ]);

      let duel = null, hStand = null, aStand = null;
      const jobs = [];
      if (ht && at) jobs.push(h2h(ht.id, at.id, apiKey).then((d) => { duel = d; }));
      if (lg && ht) jobs.push(standing(lg.leagueId, lg.season, ht.id, apiKey).then((d) => { hStand = d; }));
      if (lg && at) jobs.push(standing(lg.leagueId, lg.season, at.id, apiKey).then((d) => { aStand = d; }));
      await Promise.all(jobs);

      const facts = {
        homeName: ht ? ht.name : home, awayName: at ? at.name : away,
        homeForm: hForm, awayForm: aForm, h2h: duel,
        homeStanding: hStand, awayStanding: aStand,
        league: lg ? lg.leagueName : null, source: 'api-football'
      };
      if (!(hForm || aForm || duel || hStand || aStand)) {
        return { noData: true, reason: lastError || `aucune donnée récente (équipes trouvées : ${facts.homeName} / ${facts.awayName})` };
      }
      facts.text = formatText(facts);
      return facts;
    } catch (e) { return { noData: true, reason: String((e && e.message) || e) }; }
  }

  function fmtForm(name, f, stand) {
    if (!f) return `- ${name} : forme récente indisponible.`;
    const xg = (f.xgFor != null) ? ` xG récent : ${f.xgFor} pour / ${f.xgAg} contre (3 derniers).` : '';
    const pos = stand ? ` Classement : ${stand.position}e/${stand.total} (${stand.points} pts).` : '';
    const last = f.recent.slice(0, 5).map((r) => `${r.score} ${r.home ? 'dom' : 'ext'} vs ${r.opp} (${r.res})`).join(' ; ');
    return `- ${name} : ${f.w}V ${f.d}N ${f.l}D sur ${f.played} matchs, ${f.gf} buts pour / ${f.ga} contre. Série (récent→ancien) : ${f.streak}.${xg}${pos}\n    Derniers : ${last}.`;
  }

  function formatText(f) {
    const lines = ['# DONNÉES RÉELLES (API-Football — base factuelle, ne rien inventer au-delà) :'];
    lines.push(fmtForm(f.homeName, f.homeForm, f.homeStanding));
    lines.push(fmtForm(f.awayName, f.awayForm, f.awayStanding));
    if (f.h2h && f.h2h.n) lines.push(`- Confrontations directes (${f.h2h.n}) : ${f.h2h.t1Wins} victoires ${f.homeName}, ${f.h2h.draws} nuls, ${f.h2h.t2Wins} victoires ${f.awayName}.`);
    return lines.join('\n');
  }

  return { matchFacts, findTeam };
})();
