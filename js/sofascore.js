/* ==========================================================================
   BetSmart AI — Faits réels du match via SofaScore (usage privé)
   Fournit au Radar IA des données FACTUELLES et récentes pour qu'il cesse
   d'inventer : forme récente (résultats + buts), série, confrontations
   directes (H2H), position au classement. Passe par le proxy /api/sofascore.
   Tout est défensif : en cas d'indisponibilité, on renvoie ce qu'on a (ou null)
   et le Radar retombe sur la recherche Google groundée.
   ========================================================================== */
'use strict';

const Sofa = (() => {
  const cache = new Map();
  const norm = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'fc', 'cf', 'ac', 'as', 'sc', 'rc', 'if', 'sk', 'bk', 'club', 'fk', 'sv', 'us', 'cd', 'ca']);
  const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
  const teamsMatch = (a, b) => {
    const ta = toks(a), tb = norm(b);
    return ta.some((t) => tb.includes(t)) || toks(b).some((t) => norm(a).includes(t));
  };

  // Sport français → slug SofaScore (pour filtrer la recherche)
  const SPORT_SLUG = {
    football: 'football', foot: 'football', tennis: 'tennis',
    basket: 'basketball', basketball: 'basketball', rugby: 'rugby',
    hockey: 'ice-hockey', handball: 'handball', hand: 'handball',
    baseball: 'baseball', volley: 'volleyball', volleyball: 'volleyball',
    mma: 'mma', boxe: 'boxing'
  };

  async function api(path) {
    const key = path;
    const c = cache.get(key);
    if (c && Date.now() - c.at < 300000) return c.data;
    try {
      const r = await fetch(`/api/sofascore?p=${encodeURIComponent(path)}`);
      const j = await r.json();
      const data = j && j.ok ? j.data : null;
      cache.set(key, { at: Date.now(), data });
      return data;
    } catch (_) { return null; }
  }

  /** Recherche l'équipe → { id, name } le plus pertinent pour ce sport. */
  async function findTeam(name, sport) {
    if (!name) return null;
    const d = await api(`/search/all?q=${encodeURIComponent(name)}`);
    const results = (d && d.results) || [];
    const wantSport = SPORT_SLUG[norm(sport).split(' ')[0]] || null;
    const teams = results.filter((r) => r.type === 'team' && r.entity)
      .map((r) => r.entity)
      .filter((e) => !wantSport || (e.sport && e.sport.slug === wantSport));
    if (!teams.length) return null;
    // priorité : correspondance de nom, puis popularité (userCount)
    teams.sort((a, b) => (b.userCount || 0) - (a.userCount || 0));
    const exact = teams.find((t) => teamsMatch(name, t.name));
    const t = exact || teams[0];
    return { id: t.id, name: t.name };
  }

  const RES = { won: 'V', lost: 'D', draw: 'N' };
  const outcome = (ev, teamId) => {
    const w = ev.winnerCode; // 1 dom, 2 ext, 3 nul
    if (w === 3) return 'draw';
    const isHome = ev.homeTeam && ev.homeTeam.id === teamId;
    return (w === 1 && isHome) || (w === 2 && !isHome) ? 'won' : 'lost';
  };

  /** Forme récente d'une équipe : n derniers matchs terminés. */
  async function recentForm(teamId, n = 6) {
    const d = await api(`/team/${teamId}/events/last/0`);
    let evs = ((d && d.events) || []).filter((e) => e.status && e.status.type === 'finished');
    evs = evs.slice(-n).reverse(); // plus récent d'abord
    let w = 0, l = 0, dr = 0, gf = 0, ga = 0;
    const recent = evs.map((e) => {
      const isHome = e.homeTeam.id === teamId;
      const g = isHome ? e.homeScore.current : e.awayScore.current;
      const gc = isHome ? e.awayScore.current : e.homeScore.current;
      gf += g || 0; ga += gc || 0;
      const r = outcome(e, teamId);
      if (r === 'won') w++; else if (r === 'lost') l++; else dr++;
      return {
        opp: isHome ? e.awayTeam.name : e.homeTeam.name,
        score: `${g}-${gc}`, res: RES[r], home: isHome,
        date: new Date(e.startTimestamp * 1000).toISOString().slice(0, 10)
      };
    });
    if (!recent.length) return null;
    return { played: recent.length, w, d: dr, l, gf, ga, streak: recent.map((x) => x.res).join(' '), recent };
  }

  /** Trouve la rencontre à venir (ou en cours) pour retrouver l'eventId + le tournoi. */
  async function findFixture(teamId, opponentName, dISO) {
    for (const when of ['next', 'last']) {
      const d = await api(`/team/${teamId}/events/${when}/0`);
      const evs = (d && d.events) || [];
      const target = dISO ? new Date(dISO + 'T12:00:00').getTime() : null;
      const hit = evs.find((e) => {
        const opp = e.homeTeam.id === teamId ? e.awayTeam.name : e.homeTeam.name;
        if (!teamsMatch(opponentName, opp)) return false;
        if (target && Math.abs(e.startTimestamp * 1000 - target) > 3 * 864e5) return false;
        return true;
      });
      if (hit) return hit;
    }
    return null;
  }

  /** Résumé H2H depuis un event (bilan des confrontations). */
  async function h2h(eventId, homeName) {
    const d = await api(`/event/${eventId}/h2h`);
    const duel = d && d.teamDuel;
    if (!duel) return null;
    return { homeWins: duel.homeWins || 0, draws: duel.draws || 0, awayWins: duel.awayWins || 0, homeName };
  }

  /** Classement : position + points d'une équipe dans le tournoi de l'event. */
  async function standing(ev, teamId) {
    try {
      const ut = ev.tournament && ev.tournament.uniqueTournament;
      const sid = ev.season && ev.season.id;
      if (!ut || !sid) return null;
      const d = await api(`/unique-tournament/${ut.id}/season/${sid}/standings/total`);
      const rows = (d && d.standings && d.standings[0] && d.standings[0].rows) || [];
      const row = rows.find((r) => r.team && r.team.id === teamId);
      if (!row) return null;
      return { position: row.position, points: row.points, played: row.matches, total: rows.length };
    } catch (_) { return null; }
  }

  /**
   * Rassemble les faits d'un match et produit un bloc texte compact
   * (destiné au prompt) + un objet structuré (pour l'UI).
   * pick = { match/home/away, sport, date_match }.
   */
  async function matchFacts({ home, away, sport, date }) {
    if (!home || !away) return null;
    try {
      const [ht, at] = await Promise.all([findTeam(home, sport), findTeam(away, sport)]);
      if (!ht && !at) return null;

      const [hForm, aForm, fixture] = await Promise.all([
        ht ? recentForm(ht.id) : null,
        at ? recentForm(at.id) : null,
        ht ? findFixture(ht.id, away, date) : null
      ]);

      let duel = null, hStand = null, aStand = null;
      if (fixture) {
        const homeName = fixture.homeTeam.name;
        [duel, hStand, aStand] = await Promise.all([
          h2h(fixture.id, homeName),
          ht ? standing(fixture, ht.id) : null,
          at ? standing(fixture, at.id) : null
        ]);
      }

      const facts = {
        homeName: ht ? ht.name : home, awayName: at ? at.name : away,
        homeForm: hForm, awayForm: aForm, h2h: duel,
        homeStanding: hStand, awayStanding: aStand,
        sofaEventId: fixture ? fixture.id : null,
        source: 'sofascore'
      };
      const hasAny = hForm || aForm || duel || hStand || aStand;
      if (!hasAny) return null;
      facts.text = formatFactsText(facts);
      return facts;
    } catch (_) { return null; }
  }

  function fmtForm(name, f, stand) {
    if (!f) return `- ${name} : forme récente indisponible.`;
    const last = f.recent.slice(0, 5)
      .map((r) => `${r.score} ${r.home ? 'dom' : 'ext'} vs ${r.opp} (${r.res})`).join(' ; ');
    const pos = stand ? ` Classement : ${stand.position}e/${stand.total} (${stand.points} pts).` : '';
    return `- ${name} : ${f.w}V ${f.d}N ${f.l}D sur ${f.played} matchs, ${f.gf} buts pour / ${f.ga} contre. Série (récent→ancien) : ${f.streak}.${pos}\n    Derniers : ${last}.`;
  }

  function formatFactsText(f) {
    const lines = ['# DONNÉES RÉELLES (SofaScore — à utiliser comme base factuelle) :'];
    lines.push(fmtForm(f.homeName, f.homeForm, f.homeStanding));
    lines.push(fmtForm(f.awayName, f.awayForm, f.awayStanding));
    if (f.h2h) {
      lines.push(`- Confrontations directes : ${f.h2h.homeWins} victoires ${f.homeName}, ${f.h2h.draws} nuls, ${f.h2h.awayWins} victoires adverses.`);
    }
    return lines.join('\n');
  }

  return { matchFacts, findTeam, recentForm };
})();
