/* ==========================================================================
   BetSmart AI — Lanceurs partants MLB (statsapi.mlb.com)
   --------------------------------------------------------------------------
   Au baseball, le lanceur partant est de loin le facteur le plus déterminant
   d'un match : un écart d'ERA de 3 points entre les deux partants pèse plus
   que tout l'écart de niveau entre les deux équipes. Un modèle qui l'ignore
   est structurellement faux.

   MLB StatsAPI est public, gratuit et sans clé : aucune consommation du quota
   api-sports. Deux requêtes suffisent pour toute une journée de matchs
   (le calendrier du jour, puis les statistiques des partants en un seul lot),
   et le résultat est mis en cache pour la durée de la session.
   ========================================================================== */
'use strict';

const MLB = (() => {

  const API = 'https://statsapi.mlb.com/api/v1';
  const norm = (s) => String(s || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  const cache = { day: null, games: null, pitchers: null, at: 0 };
  const FRESH = 30 * 60e3;   // les partants annoncés bougent : 30 min de cache

  async function json(url) {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      return r.ok ? await r.json() : null;
    } catch (_) { return null; }
  }

  /** Date au format AAAA-MM-JJ dans le fuseau de la MLB (les matchs du soir
      côté est américain tombent le lendemain en heure de Paris). */
  function mlbDate(when) {
    const d = when ? new Date(when) : new Date();
    // -8 h ramène un match de 01:07 à Paris sur la bonne journée américaine
    return new Date(d.getTime() - 8 * 3600e3).toISOString().slice(0, 10);
  }

  /** Calendrier du jour avec les partants annoncés. */
  async function schedule(when) {
    const day = mlbDate(when);
    if (cache.day === day && cache.games && Date.now() - cache.at < FRESH) return cache.games;
    const url = `${API}/schedule?sportId=1&date=${day}&hydrate=probablePitcher`
      + '&fields=dates,games,gamePk,gameDate,teams,away,home,team,name,id,probablePitcher,fullName';
    const j = await json(url);
    const games = [];
    for (const d of (j && j.dates) || []) {
      for (const g of d.games || []) {
        const h = g.teams?.home, a = g.teams?.away;
        if (!h?.team || !a?.team) continue;
        games.push({
          gamePk: g.gamePk, gameDate: g.gameDate,
          home: h.team.name, away: a.team.name,
          homePitcher: h.probablePitcher ? { id: h.probablePitcher.id, name: h.probablePitcher.fullName } : null,
          awayPitcher: a.probablePitcher ? { id: a.probablePitcher.id, name: a.probablePitcher.fullName } : null
        });
      }
    }
    cache.day = day; cache.games = games; cache.at = Date.now(); cache.pitchers = null;
    return games;
  }

  /** Statistiques de la saison en cours pour un lot de lanceurs (une requête). */
  async function pitcherStats(ids) {
    const want = [...new Set(ids.filter(Boolean))];
    if (!want.length) return {};
    cache.pitchers = cache.pitchers || {};
    const missing = want.filter((id) => cache.pitchers[id] === undefined);
    if (missing.length) {
      const season = new Date().getFullYear();
      const url = `${API}/people?personIds=${missing.join(',')}`
        + `&hydrate=stats(group=[pitching],type=[season],season=${season})`;
      const j = await json(url);
      for (const p of (j && j.people) || []) {
        // Un lanceur transféré en cours de saison a une ligne par équipe plus
        // une ligne cumulée : on retient la plus fournie (le cumul saison).
        const splits = (p.stats || []).flatMap((s) => s.splits || []);
        let best = null;
        for (const sp of splits) {
          const ip = parseFloat(sp.stat?.inningsPitched || 0);
          if (!best || ip > best.ip) best = { ip, stat: sp.stat, team: sp.team?.name || null };
        }
        cache.pitchers[p.id] = best ? {
          id: p.id, name: p.fullName, team: best.team,
          era: parseFloat(best.stat.era), whip: parseFloat(best.stat.whip),
          ip: best.ip, wins: best.stat.wins, losses: best.stat.losses,
          hr9: parseFloat(best.stat.homeRunsPer9), k9: parseFloat(best.stat.strikeoutsPer9),
          bb9: parseFloat(best.stat.walksPer9), starts: best.stat.gamesStarted,
          // Nombre d'équipes traversées cette saison : signale un transfert récent
          teams: new Set(splits.map((s) => s.team?.name).filter(Boolean)).size
        } : null;
      }
      for (const id of missing) if (cache.pitchers[id] === undefined) cache.pitchers[id] = null;
    }
    const out = {};
    for (const id of want) if (cache.pitchers[id]) out[id] = cache.pitchers[id];
    return out;
  }

  /** Proximité entre deux libellés d'équipe, tolérante aux abréviations de ville.
      Coteur écrit « BOS Red Sox » là où la MLB écrit « Boston Red Sox » : aucun
      mot commun de 4 lettres ou plus, il faut donc raisonner par préfixes. */
  function affinity(x, y) {
    const wx = norm(x).split(' ').filter(Boolean);
    const wy = norm(y).split(' ').filter(Boolean);
    if (!wx.length || !wy.length) return 0;
    let hits = 0;
    for (const w of wx) {
      if (wy.some((v) => v === w || (w.length >= 3 && v.startsWith(w)) || (v.length >= 3 && w.startsWith(v)))) hits++;
    }
    return hits / Math.min(wx.length, wy.length);
  }

  /** Retrouve le match du jour correspondant à deux noms d'équipes.
      Renvoie { game, flipped } — flipped indique que le libellé fourni est
      dans l'ordre inverse de celui de la MLB. */
  function findGame(games, home, away) {
    let best = null;
    for (const g of games) {
      const direct = Math.min(affinity(home, g.home), affinity(away, g.away));
      const rev = Math.min(affinity(home, g.away), affinity(away, g.home));
      const score = Math.max(direct, rev);
      if (score >= 0.5 && (!best || score > best.score)) {
        best = { game: g, flipped: rev > direct, score };
      }
    }
    return best;
  }

  /** ERA moyenne des partants de la ligue — référence pour situer un lanceur.
      Recalculée sur les partants du jour plutôt que codée en dur. */
  function leagueEra(stats) {
    const vals = Object.values(stats).filter((p) => p && p.ip >= 20 && isFinite(p.era));
    if (vals.length < 4) return 4.20;
    const tot = vals.reduce((s, p) => s + p.era * p.ip, 0);
    const ip = vals.reduce((s, p) => s + p.ip, 0);
    return ip > 0 ? tot / ip : 4.20;
  }

  /**
   * Ajustement de probabilité apporté par le duel de partants.
   * Principe : l'écart d'ERA entre les deux partants, ramené aux ~5,5 manches
   * qu'un partant couvre en moyenne, donne un écart de points attendus. En MLB,
   * une course d'écart vaut grossièrement 9 à 10 points de probabilité autour
   * de 50 %. On borne volontairement l'effet : l'ERA est bruitée, le bullpen et
   * l'attaque comptent pour le reste du match.
   *
   * Renvoie { delta, text, quality } — delta à ajouter à la proba de l'équipe
   * à domicile, ou null si les deux partants ne sont pas connus.
   */
  function pitcherEdge(homeP, awayP, lgEra) {
    if (!homeP || !awayP) return null;
    if (!(homeP.ip >= 15) || !(awayP.ip >= 15)) return null;   // échantillon trop court
    const shrink = (p) => {
      // Régression vers la moyenne : une ERA sur 40 manches ne vaut pas une
      // ERA sur 150. Poids = ip / (ip + 60).
      const w = p.ip / (p.ip + 60);
      return w * p.era + (1 - w) * lgEra;
    };
    const eH = shrink(homeP), eA = shrink(awayP);
    const runs = (eA - eH) * (5.5 / 9);          // avantage en points pour l'équipe à domicile

    // DOUBLE COMPTAGE — correction essentielle. Le niveau Pythagenpat de
    // l'équipe intègre déjà la contribution de sa rotation sur toute la saison.
    // Appliquer l'écart brut des partants reviendrait à compter deux fois la
    // même information et produirait des probabilités absurdes (on obtenait
    // 70 % là où le marché dit 57 %, soit un avantage de 14 points qu'aucun
    // moneyline MLB ne laisse traîner). Seule la DÉVIATION du partant du jour
    // par rapport au partant moyen de son équipe est une information nouvelle :
    // on retient donc environ la moitié de l'écart.
    const NEW_INFO = 0.5;
    let delta = runs * 0.095 * NEW_INFO;          // ~9,5 points de proba par course
    delta = Math.max(-0.09, Math.min(0.09, delta));
    const fmt = (p, e) => `${p.name} (${p.era.toFixed(2)} ERA sur ${p.ip.toFixed(0)} manches, ${p.wins}-${p.losses}`
      + (isFinite(p.hr9) ? `, ${p.hr9.toFixed(2)} HR/9` : '')
      + `${p.teams > 1 ? `, transféré en cours de saison — ${p.starts} départs au total` : ''})`
      + (Math.abs(e - p.era) > 0.3 ? ` [ramené à ${e.toFixed(2)} après régression vers la moyenne]` : '');
    return {
      delta,
      quality: (homeP.ip >= 60 && awayP.ip >= 60) ? 'ok' : 'short',
      text: `Partants annoncés — domicile : ${fmt(homeP, eH)} · extérieur : ${fmt(awayP, eA)}. ERA de référence des partants du jour : ${lgEra.toFixed(2)}.`
    };
  }

  /** Point d'entrée : tout ce qu'on sait du duel de partants d'un match. */
  async function starters({ home, away, when }) {
    const games = await schedule(when);
    if (!games || !games.length) return null;
    const found = findGame(games, home, away);
    if (!found) return null;
    const g = found.game;
    // Le calendrier peut donner le match dans l'autre sens que le libellé du book
    const hp = found.flipped ? g.awayPitcher : g.homePitcher;
    const ap = found.flipped ? g.homePitcher : g.awayPitcher;
    if (!hp && !ap) return { game: g, edge: null, reason: 'partants non encore annoncés' };
    const stats = await pitcherStats([hp?.id, ap?.id]);
    const H = hp ? stats[hp.id] : null, A = ap ? stats[ap.id] : null;
    if (!H || !A) return { game: g, edge: null, reason: 'statistiques de partant indisponibles' };
    return { game: g, home: H, away: A, edge: pitcherEdge(H, A, leagueEra(stats)) };
  }

  return { starters, schedule, pitcherStats, pitcherEdge, leagueEra, findGame };
})();
