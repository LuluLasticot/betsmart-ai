/* ==========================================================================
   BetSmart AI — Faits réels du match via api-sports.io (multi-sports)
   Une seule clé couvre : football (v3, avec xG), basket, hockey, baseball,
   rugby, volley, handball (v1). Fournit forme récente, buts/points, H2H,
   classement (foot) → le Radar cesse d'inventer. Sports individuels (tennis,
   MMA, boxe) non couverts → repli recherche groundée. Défensif de bout en bout.
   ========================================================================== */
'use strict';

const Facts = (() => {
  const cache = new Map();
  const norm = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'fc', 'cf', 'ac', 'as', 'sc', 'rc', 'if', 'sk', 'bk', 'fk', 'sv', 'us', 'cd', 'ca', 'club']);
  const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
  const nameMatch = (a, b) => { const nb = norm(b); return toks(a).some((t) => nb.includes(t)) || toks(b).some((t) => norm(a).includes(t)); };
  const RES = { won: 'V', lost: 'D', draw: 'N' };

  // Sport (coteur/FR) → clé api-sports. null = non couvert (tennis, MMA, boxe).
  const SPORT_MAP = {
    football: 'football', foot: 'football', soccer: 'football',
    basket: 'basketball', basketball: 'basketball',
    hockey: 'hockey', 'ice-hockey': 'hockey',
    baseball: 'baseball', rugby: 'rugby',
    volley: 'volleyball', volleyball: 'volleyball',
    hand: 'handball', handball: 'handball'
  };
  const mapSport = (sport) => {
    const s = norm(sport).split(' ')[0];
    if (!s) return 'football'; // requête manuelle sans sport connu → foot par défaut
    return SPORT_MAP[s] || null;
  };

  // Sélections nationales : coteur donne le FR, api-sports attend l'anglais.
  const COUNTRY_FR_EN = {
    espagne: 'Spain', allemagne: 'Germany', angleterre: 'England', 'pays bas': 'Netherlands',
    hollande: 'Netherlands', belgique: 'Belgium', italie: 'Italy', croatie: 'Croatia',
    bresil: 'Brazil', argentine: 'Argentina', maroc: 'Morocco', suisse: 'Switzerland',
    'etats unis': 'USA', danemark: 'Denmark', suede: 'Sweden', norvege: 'Norway',
    pologne: 'Poland', autriche: 'Austria', turquie: 'Turkey', grece: 'Greece',
    ecosse: 'Scotland', serbie: 'Serbia', japon: 'Japan', mexique: 'Mexico'
  };
  const enName = (name) => COUNTRY_FR_EN[norm(name)] || name;

  let lastError = null;

  async function call(ep, key, sport = 'football') {
    const ck = `${sport}|${ep}`;
    const c = cache.get(ck);
    if (c && Date.now() - c.at < 600000) return c.data;
    try {
      const r = await fetch(`/api/facts?ep=${encodeURIComponent(ep)}&key=${encodeURIComponent(key)}&sp=${encodeURIComponent(sport)}`);
      const j = await r.json();
      if (j && !j.ok && j.error) lastError = j.error;
      const data = j && j.ok ? j.response : null;
      cache.set(ck, { at: Date.now(), data });
      return data;
    } catch (e) { lastError = String((e && e.message) || e); return null; }
  }

  // teams?search : v3 renvoie [{team:{…}}], v1 renvoie [{id,name,…}] → on gère les deux.
  async function findTeam(name, key, sport) {
    for (const q of [name, enName(name)].filter((v, i, a) => v && a.indexOf(v) === i)) {
      const res = await call(`teams?search=${encodeURIComponent(q)}`, key, sport);
      if (res && res.length) {
        const teams = res.map((x) => x.team || x).filter((t) => t && t.id);
        const t = teams.find((x) => nameMatch(q, x.name)) || teams[0];
        if (t) return { id: t.id, name: t.name };
      }
    }
    return null;
  }

  const scoreOf = (s) => (s == null ? null : (typeof s === 'object' ? (s.total ?? s.points ?? s.score ?? null) : s));

  // Plan gratuit api-sports : le paramètre "last"/"next" est INTERDIT. On requête
  // par saison (année en cours + précédente pour couvrir tous les calendriers) puis on trie.
  const SEASONS = () => { const Y = new Date().getFullYear(); return [Y, Y - 1]; };

  /* ---------- Football (v3) : forme + xG + H2H + classement ---------- */
  const FIN = new Set(['FT', 'AET', 'PEN']);
  async function recentFormFB(teamId, key, n = 6) {
    const chunks = await Promise.all(SEASONS().map((y) => call(`fixtures?team=${teamId}&season=${y}`, key, 'football')));
    const res = chunks.filter(Array.isArray).flat();
    if (!res.length) return null;
    const fins = res.filter((fx) => fx.fixture && FIN.has(fx.fixture.status.short))
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date)).slice(0, n);
    let w = 0, l = 0, dr = 0, gf = 0, ga = 0;
    const recent = fins.map((fx) => {
      const isHome = fx.teams.home.id === teamId;
      const g = isHome ? fx.goals.home : fx.goals.away;
      const gc = isHome ? fx.goals.away : fx.goals.home;
      gf += g || 0; ga += gc || 0;
      const hw = fx.teams.home.winner === true, aw = fx.teams.away.winner === true;
      const r = (!hw && !aw) ? 'draw' : ((isHome && hw) || (!isHome && aw)) ? 'won' : 'lost';
      if (r === 'won') w++; else if (r === 'lost') l++; else dr++;
      return { id: fx.fixture.id, opp: isHome ? fx.teams.away.name : fx.teams.home.name, score: `${g}-${gc}`, res: RES[r], home: isHome, date: (fx.fixture.date || '').slice(0, 10) };
    });
    if (!recent.length) return null;
    let xgFor = null, xgAg = null;
    const sample = recent.slice(0, 3);
    const stats = await Promise.all(sample.map((m) => call(`fixtures/statistics?fixture=${m.id}`, key, 'football')));
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
    return { played: recent.length, w, d: dr, l, gf, ga, streak: recent.map((x) => x.res).join(' '), recent, xgFor, xgAg, _league: fins[0].league || null };
  }
  async function h2hFB(id1, id2, key) {
    const res = await call(`fixtures/headtohead?h2h=${id1}-${id2}`, key, 'football');
    if (!res || !res.length) return null;
    let w1 = 0, w2 = 0, dr = 0;
    res.filter((fx) => FIN.has(fx.fixture.status.short)).forEach((fx) => {
      const hw = fx.teams.home.winner === true, aw = fx.teams.away.winner === true, homeIs1 = fx.teams.home.id === id1;
      if (!hw && !aw) dr++; else if ((hw && homeIs1) || (aw && !homeIs1)) w1++; else w2++;
    });
    return { t1Wins: w1, draws: dr, t2Wins: w2, n: w1 + w2 + dr };
  }
  async function standingFB(leagueId, season, teamId, key) {
    const res = await call(`standings?league=${leagueId}&season=${season}`, key, 'football');
    try {
      const table = res[0].league.standings.flat();
      const row = table.find((r) => r.team && r.team.id === teamId);
      return row ? { position: row.rank, points: row.points, total: table.length } : null;
    } catch (_) { return null; }
  }

  // Rencontre à venir (non commencée) entre deux équipes, dans les fixtures de saison
  // (déjà en cache via recentFormFB → pas de coût réseau supplémentaire).
  const NS = new Set(['TBD', 'NS', 'PST']);
  async function upcomingFixtureFB(id1, id2, key) {
    const chunks = await Promise.all(SEASONS().map((y) => call(`fixtures?team=${id1}&season=${y}`, key, 'football')));
    const res = chunks.filter(Array.isArray).flat();
    const now = Date.now();
    const cand = res.filter((fx) => fx.fixture && NS.has(fx.fixture.status.short)
      && (fx.teams.home.id === id2 || fx.teams.away.id === id2))
      .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    // Le prochain à venir (ou le plus proche si tous passés en statut NS résiduel)
    const next = cand.find((fx) => new Date(fx.fixture.date).getTime() >= now - 6 * 3600e3) || cand[0];
    return next ? { id: next.fixture.id, date: (next.fixture.date || '').slice(0, 10), venue: (next.fixture.venue && next.fixture.venue.name) || null } : null;
  }

  // Blessures/absences précises pour une rencontre donnée → {teamId → [{player, reason, type}]}
  async function injuriesByFixtureFB(fixtureId, key) {
    const res = await call(`injuries?fixture=${fixtureId}`, key, 'football');
    if (!Array.isArray(res) || !res.length) return null;
    const by = {};
    res.forEach((it) => {
      const tid = it.team && it.team.id; if (!tid) return;
      (by[tid] = by[tid] || []).push({ player: (it.player && it.player.name) || '?', reason: (it.player && it.player.reason) || it.reason || '', type: (it.player && it.player.type) || it.type || '' });
    });
    return by;
  }
  // Repli : absences récentes par équipe sur la saison (dédoublonné par joueur, dernières en date)
  async function injuriesByTeamFB(teamId, key) {
    const Y = new Date().getFullYear();
    const chunks = await Promise.all([Y, Y - 1].map((y) => call(`injuries?team=${teamId}&season=${y}`, key, 'football')));
    const res = chunks.filter(Array.isArray).flat();
    if (!res.length) return null;
    res.sort((a, b) => new Date((b.fixture && b.fixture.date) || 0) - new Date((a.fixture && a.fixture.date) || 0));
    const seen = new Set(); const out = [];
    const cut = Date.now() - 21 * 86400e3; // absences des ~3 dernières semaines
    for (const it of res) {
      const nm = it.player && it.player.name; if (!nm || seen.has(nm)) continue;
      const d = new Date((it.fixture && it.fixture.date) || 0).getTime();
      if (d < cut) continue;
      seen.add(nm);
      out.push({ player: nm, reason: (it.player && it.player.reason) || '', type: (it.player && it.player.type) || '' });
      if (out.length >= 6) break;
    }
    return out.length ? out : null;
  }

  // Compositions (probables/confirmées) — disponibles ~20-40 min avant le coup d'envoi
  async function lineupsFB(fixtureId, key) {
    const res = await call(`fixtures/lineups?fixture=${fixtureId}`, key, 'football');
    if (!Array.isArray(res) || !res.length) return null;
    const by = {};
    res.forEach((l) => {
      const tid = l.team && l.team.id; if (!tid) return;
      by[tid] = {
        formation: l.formation || null,
        coach: (l.coach && l.coach.name) || null,
        xi: (l.startXI || []).map((e) => e.player && e.player.name).filter(Boolean)
      };
    });
    return Object.keys(by).length ? by : null;
  }

  /* ---------- Sports d'équipe (v1) : forme (buts/points) + H2H ---------- */
  async function recentFormV1(teamId, key, sport, n = 6) {
    const chunks = await Promise.all(SEASONS().map((y) => call(`games?team=${teamId}&season=${y}`, key, sport)));
    const res = chunks.filter(Array.isArray).flat();
    if (!res.length) return null;
    const games = res.filter((g) => scoreOf(g.scores && g.scores.home) != null && scoreOf(g.scores && g.scores.away) != null)
      .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, n);
    let w = 0, l = 0, dr = 0, gf = 0, ga = 0;
    const recent = games.map((g) => {
      const isHome = g.teams.home.id === teamId;
      const h = scoreOf(g.scores.home), a = scoreOf(g.scores.away);
      const my = isHome ? h : a, op = isHome ? a : h;
      gf += my; ga += op;
      const r = my > op ? 'won' : my < op ? 'lost' : 'draw';
      if (r === 'won') w++; else if (r === 'lost') l++; else dr++;
      return { opp: isHome ? g.teams.away.name : g.teams.home.name, score: `${my}-${op}`, res: RES[r], home: isHome, date: (g.date || '').slice(0, 10) };
    });
    if (!recent.length) return null;
    return { played: recent.length, w, d: dr, l, gf, ga, streak: recent.map((x) => x.res).join(' '), recent, xgFor: null, xgAg: null };
  }
  async function h2hV1(id1, id2, key, sport) {
    const res = await call(`games?h2h=${id1}-${id2}`, key, sport);
    if (!res || !res.length) return null;
    let w1 = 0, w2 = 0, dr = 0;
    res.forEach((g) => {
      const h = scoreOf(g.scores && g.scores.home), a = scoreOf(g.scores && g.scores.away);
      if (h == null || a == null) return;
      const homeIs1 = g.teams.home.id === id1;
      if (h === a) dr++; else if ((h > a && homeIs1) || (a > h && !homeIs1)) w1++; else w2++;
    });
    return { t1Wins: w1, draws: dr, t2Wins: w2, n: w1 + w2 + dr };
  }

  /* ---------- Orchestration ---------- */
  async function matchFacts({ home, away, sport, apiKey }) {
    if (!apiKey || !home || !away) return null;
    const sk = mapSport(sport);
    if (!sk) return { noData: true, reason: `sport « ${sport || '?'} » non couvert par api-sports (tennis, MMA, boxe : recherche web)` };
    lastError = null;
    try {
      const [ht, at] = await Promise.all([findTeam(home, apiKey, sk), findTeam(away, apiKey, sk)]);
      if (!ht && !at) return { noData: true, reason: lastError || 'équipes introuvables dans api-sports' };

      let hForm = null, aForm = null, duel = null, hStand = null, aStand = null, league = null;
      let hInj = null, aInj = null, hLineup = null, aLineup = null, venue = null;
      if (sk === 'football') {
        [hForm, aForm] = await Promise.all([
          ht ? recentFormFB(ht.id, apiKey) : null,
          at ? recentFormFB(at.id, apiKey) : null
        ]);
        // Ligue = celle de la rencontre la plus récente (issue de la forme)
        const lg = (hForm && hForm._league) || (aForm && aForm._league) || null;
        const jobs = [];
        if (ht && at) jobs.push(h2hFB(ht.id, at.id, apiKey).then((d) => { duel = d; }));
        if (lg && lg.id && ht) jobs.push(standingFB(lg.id, lg.season, ht.id, apiKey).then((d) => { hStand = d; }));
        if (lg && lg.id && at) jobs.push(standingFB(lg.id, lg.season, at.id, apiKey).then((d) => { aStand = d; }));
        // Blessures/compos : cibler la rencontre à venir si on la trouve, sinon repli par équipe
        if (ht && at) {
          jobs.push(upcomingFixtureFB(ht.id, at.id, apiKey).then(async (fx) => {
            if (fx) {
              venue = fx.venue;
              const [inj, lu] = await Promise.all([injuriesByFixtureFB(fx.id, apiKey), lineupsFB(fx.id, apiKey)]);
              if (inj) { hInj = inj[ht.id] || null; aInj = inj[at.id] || null; }
              if (lu) { hLineup = lu[ht.id] || null; aLineup = lu[at.id] || null; }
            }
            // Repli blessures par équipe si la rencontre n'a rien donné
            if (!hInj) hInj = await injuriesByTeamFB(ht.id, apiKey);
            if (!aInj) aInj = await injuriesByTeamFB(at.id, apiKey);
          }));
        }
        await Promise.all(jobs);
        league = lg ? lg.name : null;
      } else {
        [hForm, aForm] = await Promise.all([
          ht ? recentFormV1(ht.id, apiKey, sk) : null,
          at ? recentFormV1(at.id, apiKey, sk) : null
        ]);
        if (ht && at) duel = await h2hV1(ht.id, at.id, apiKey, sk);
      }

      const facts = {
        homeName: ht ? ht.name : home, awayName: at ? at.name : away,
        homeForm: hForm, awayForm: aForm, h2h: duel,
        homeStanding: hStand, awayStanding: aStand, league, venue,
        homeInjuries: hInj, awayInjuries: aInj, homeLineup: hLineup, awayLineup: aLineup,
        sport: sk, source: 'api-sports'
      };
      if (!(hForm || aForm || duel || hStand || aStand || hInj || aInj)) {
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
    return `- ${name} : ${f.w}V ${f.d}N ${f.l}D sur ${f.played} matchs, ${f.gf} marqués / ${f.ga} encaissés. Série (récent→ancien) : ${f.streak}.${xg}${pos}\n    Derniers : ${last}.`;
  }
  const fmtInj = (name, list) => {
    if (!list || !list.length) return `- ${name} : aucune absence signalée dans les données.`;
    const items = list.slice(0, 6).map((i) => `${i.player}${i.reason ? ' (' + i.reason + ')' : ''}${i.type && !/out|missing/i.test(i.type) ? ' [' + i.type + ']' : ''}`).join(', ');
    return `- ${name} — absents/incertains : ${items}.`;
  };
  const fmtLineup = (name, l) => {
    if (!l) return null;
    const xi = l.xi && l.xi.length ? ` XI : ${l.xi.join(', ')}.` : '';
    return `- ${name}${l.formation ? ' (' + l.formation + ')' : ''}${l.coach ? ' — coach ' + l.coach : ''}.${xi}`;
  };
  function formatText(f) {
    const lines = ['# DONNÉES RÉELLES (api-sports — base factuelle, ne rien inventer au-delà) :'];
    lines.push(fmtForm(f.homeName, f.homeForm, f.homeStanding));
    lines.push(fmtForm(f.awayName, f.awayForm, f.awayStanding));
    if (f.h2h && f.h2h.n) lines.push(`- Confrontations directes (${f.h2h.n}) : ${f.h2h.t1Wins} victoires ${f.homeName}, ${f.h2h.draws} nuls, ${f.h2h.t2Wins} victoires ${f.awayName}.`);
    if (f.homeInjuries || f.awayInjuries) {
      lines.push('## Blessures / suspensions (impact fort sur l\'issue — à pondérer) :');
      lines.push(fmtInj(f.homeName, f.homeInjuries));
      lines.push(fmtInj(f.awayName, f.awayInjuries));
    }
    const lus = [fmtLineup(f.homeName, f.homeLineup), fmtLineup(f.awayName, f.awayLineup)].filter(Boolean);
    if (lus.length) { lines.push('## Compositions annoncées :'); lus.forEach((l) => lines.push(l)); }
    return lines.join('\n');
  }

  return { matchFacts, findTeam };
})();
