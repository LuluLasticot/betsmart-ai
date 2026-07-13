/* ==========================================================================
   BetSmart AI — Moteur d'analytics complet (page Analyse)
   Agrège les paris réglés sur toutes les dimensions : sport (+ligues),
   bookmaker, type, tipster, tranches de cote/mise, jour/semaine/mois/année,
   plus les métriques pro (profit factor, drawdown, calibration).
   ========================================================================== */
'use strict';

const Analytics = (() => {

  const profit = Stats.profit;
  const isCounted = Stats.isCounted;

  /** Nom de compétition canonique : fusionne les variantes (année, tour, parenthèses,
      « TRJ », préfixes de source) pour éviter les doublons dans l'analyse. */
  function canonComp(raw) {
    let s = String(raw || '').trim();
    if (!s) return 'Autre';
    s = s
      .replace(/\bTRJ\s*:?\s*%?/gi, ' ')                                   // "TRJ: %"
      .replace(/\([^)]*\)/g, ' ')                                          // "(EFG Swiss Open)"
      .replace(/\b20\d{2}(?:[/-]\d{2,4})?\b/g, ' ')                        // "2026", "2026/27"
      .replace(/\b(round of \d+|1\/\d+(?:e|es)?|8es?|16es?|32es?|quarts?|demi[- ]?finales?|finales?|qualifications?|qualif\.?|barrages?|phase de groupes?|groupe [a-h]|poules?|\d+\s*(?:er|e|ème|eme)?\s+tour|tour\s+\d+|matchs?\s+(?:retour|aller)|aller|retour)\b/gi, ' ')
      .replace(/[\s,;:–—-]+$/g, '')                                        // ponctuation de fin
      .replace(/\s{2,}/g, ' ')
      .trim();
    const n = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    // Tournois du Grand Chelem : on garde les tableaux distincts (ATP / WTA / mixte)
    const MAJORS = new Set(['Wimbledon', 'Roland-Garros', 'US Open', "Open d'Australie"]);
    const ALIAS = [
      [/wimbledon/, 'Wimbledon'],
      [/roland[- ]?garros|french open/, 'Roland-Garros'],
      [/\bus open\b/, 'US Open'],
      [/australian open|open d.?australie/, "Open d'Australie"],
      [/gstaad|efg swiss open/, 'ATP Gstaad'],
      [/umag|plava laguna/, 'ATP Umag'],
      [/ath[eè]nes|athens/, 'WTA Athènes'],
      [/ligue des champions|champions league|\bldc\b|uefa.*qualif/, 'Ligue des Champions'],
      [/ligue europa|europa league/, 'Ligue Europa'],
      [/coupe du monde|world cup|\bfifa\b|\bcdm\b/, 'Coupe du Monde'],
      [/ligue des nations|nations league/, 'Ligue des Nations'],
      [/tour de france/, 'Tour de France']
    ];
    // Détecte le tableau (à partir du libellé brut, avant nettoyage)
    const rawN = String(raw || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const tour = /mixte|mixed/.test(rawN) ? ' (mixte)'
      : /\bwta\b|\bfemmes?\b|\bdames?\b|\bwomen\b|\bf\b/.test(rawN) ? ' (WTA)'
      : /\batp\b|\bhommes?\b|\bmessieurs\b|\bmen\b|\bh\b/.test(rawN) ? ' (ATP)' : '';
    for (const [re, name] of ALIAS) if (re.test(n)) return MAJORS.has(name) ? name + tour : name;
    if (!s) return 'Autre';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** Bloc de stats pour un ensemble de paris. */
  function block(bets) {
    const counted = bets.filter(isCounted);
    const won = bets.filter((b) => b.status === 'won').length;
    const lost = bets.filter((b) => b.status === 'lost').length;
    const cashout = bets.filter((b) => b.status === 'cashout').length;
    const voidC = bets.filter((b) => b.status === 'void').length;
    const pending = bets.filter((b) => b.status === 'pending').length;

    const totalStake = counted.reduce((s, b) => s + Number(b.stake || 0), 0);
    const totalProfit = counted.reduce((s, b) => s + profit(b), 0);
    const gross = counted.reduce((a, b) => {
      const p = profit(b);
      if (p > 0) a.win += p; else a.loss += -p;
      return a;
    }, { win: 0, loss: 0 });
    const settledCount = won + lost;

    return {
      count: bets.length,
      settled: counted.length,
      won, lost, cashout, void: voidC, pending,
      totalStake,
      totalProfit,
      grossWin: gross.win,
      grossLoss: gross.loss,
      profitFactor: gross.loss > 0 ? gross.win / gross.loss : (gross.win > 0 ? Infinity : 0),
      roi: totalStake > 0 ? (totalProfit / totalStake) * 100 : 0,
      hitRate: settledCount > 0 ? (won / settledCount) * 100 : 0,
      avgOdds: counted.length ? counted.reduce((s, b) => s + Number(b.odds || 0), 0) / counted.length : 0,
      avgStake: counted.length ? totalStake / counted.length : 0
    };
  }

  /** Groupe des paris réglés par clé et renvoie les blocs triés par nb décroissant. */
  function groupBy(bets, keyFn, extra) {
    const map = new Map();
    for (const b of bets) {
      const k = (keyFn(b) || '—').toString().trim() || '—';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(b);
    }
    return [...map.entries()]
      .map(([name, set]) => ({ name, ...block(set), ...(extra ? extra(name, set) : {}) }))
      .sort((a, b) => b.count - a.count);
  }

  /* ---- Tranches ---- */
  const STAKE_RANGES = [
    { name: '0 – 5 €', min: 0, max: 5 }, { name: '5 – 10 €', min: 5, max: 10 },
    { name: '10 – 20 €', min: 10, max: 20 }, { name: '20 – 50 €', min: 20, max: 50 },
    { name: '50 €+', min: 50, max: Infinity }
  ];
  const ODDS_RANGES = [
    { name: '1.01 – 1.50', min: 1, max: 1.5 }, { name: '1.50 – 2.00', min: 1.5, max: 2 },
    { name: '2.00 – 2.50', min: 2, max: 2.5 }, { name: '2.50 – 3.50', min: 2.5, max: 3.5 },
    { name: '3.50 – 5.00', min: 3.5, max: 5 }, { name: '5.00+', min: 5, max: Infinity }
  ];

  function byRange(bets, ranges, field) {
    return ranges.map((r) => {
      const own = bets.filter((b) => Number(b[field]) >= r.min && Number(b[field]) < r.max);
      return { name: r.name, ...block(own) };
    }).filter((r) => r.count > 0);
  }

  /* ---- Périodes ---- */
  const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const MONTH_NAMES = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  function isoWeek(d) {
    const date = new Date(d.getTime());
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
    const week1 = new Date(date.getFullYear(), 0, 4);
    const w = 1 + Math.round(((date - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
    return `S${w} ${date.getFullYear()}`;
  }

  function periods(settled) {
    const dt = (b) => new Date(b.date + 'T12:00:00');
    const byDay = DAY_NAMES.map((name, i) => ({ name, ...block(settled.filter((b) => dt(b).getDay() === i)) }));
    const byWeek = groupBy(settled, (b) => isoWeek(dt(b)));
    const byMonth = groupBy(settled, (b) => `${MONTH_NAMES[dt(b).getMonth()]} ${dt(b).getFullYear()}`)
      .sort((a, b) => {
        const [am, ay] = a.name.split(' '); const [bm, by] = b.name.split(' ');
        return new Date(by, MONTH_NAMES.indexOf(bm)) - new Date(ay, MONTH_NAMES.indexOf(am));
      });
    const byYear = groupBy(settled, (b) => String(dt(b).getFullYear())).sort((a, b) => b.name.localeCompare(a.name));
    return { byDay, byWeek, byMonth, byYear };
  }

  /* ---- Courbe cumulée de profit (pour le graphe d'évolution détaillé) ---- */
  function profitCurve(settled) {
    const sorted = settled.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
    let cum = 0;
    return sorted.map((b) => { cum += profit(b); return { x: b.date, y: Math.round(cum * 100) / 100, label: b.event }; });
  }

  /** Détection de tilt : mise gonflée après une perte (fenêtre glissante). */
  function tiltAnalysis(settled) {
    const chrono = settled.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
    let windows = 0, events = 0, inflation = 0;
    for (let i = 1; i < chrono.length; i++) {
      if (chrono[i - 1].status === 'lost') {
        windows++;
        const prev = chrono.slice(Math.max(0, i - 6), i);
        const avg = prev.reduce((s, b) => s + Number(b.stake || 0), 0) / (prev.length || 1);
        const ratio = avg > 0 ? Number(chrono[i].stake || 0) / avg : 1;
        if (ratio >= 1.5) { events++; inflation += ratio; }
      }
    }
    return {
      windows, events,
      rate: windows > 0 ? (events / windows) * 100 : 0,
      avgInflation: events > 0 ? inflation / events : 0
    };
  }

  /* ---- Point d'entrée ---- */
  function compute(bets, txs, initialBankroll) {
    const settled = bets.filter(isCounted);
    const deposits = (txs || []).filter((t) => t.type === 'depot').reduce((s, t) => s + Number(t.amount || 0), 0);
    const invested = (Number(initialBankroll) || 0) + deposits;

    const general = block(bets);
    general.roc = invested > 0 ? (general.totalProfit / invested) * 100 : 0;
    general.invested = invested;

    const curve = profitCurve(settled);

    return {
      general,
      drawdown: Stats.maxDrawdown([{ y: 0 }, ...curve]),
      curve,
      outcomeDist: [
        { name: 'Gagné', value: general.won, color: '#34d399' },
        { name: 'Perdu', value: general.lost, color: '#f0655f' },
        { name: 'Cash out', value: general.cashout, color: '#5b8def' },
        { name: 'Annulé', value: general.void, color: '#8a92a6' },
        { name: 'En attente', value: general.pending, color: '#e8b45a' }
      ].filter((d) => d.value > 0),
      bySport: groupBy(settled, (b) => b.sport, (name, set) => ({ byLeague: groupBy(set, (b) => canonComp(b.competition)) })),
      byBookmaker: groupBy(settled, (b) => b.bookmaker),
      byCompetition: groupBy(settled, (b) => canonComp(b.competition), (name, set) => ({ sport: set[0]?.sport })),
      byType: groupBy(settled, (b) => ({ simple: 'Simple', combine: 'Combiné', systeme: 'Système' }[b.betType] || b.betType)),
      byTipster: groupBy(settled.filter((b) => b.tipster), (b) => b.tipster),
      byStakeRange: byRange(settled, STAKE_RANGES, 'stake'),
      byOddsRange: byRange(settled, ODDS_RANGES, 'odds'),
      ...periods(settled),
      tilt: tiltAnalysis(settled),
      settledCount: settled.length
    };
  }

  /** Résumé compact pour le Bilan IA (aucune donnée nominative). */
  function reviewSummary(a) {
    const slim = (arr, n = 8) => arr.slice(0, n).map((g) => ({ nom: g.name, nb: g.count, roi_pct: round1(g.roi), profit: round1(g.totalProfit), reussite_pct: round1(g.hitRate) }));
    return {
      global: {
        nb_paris: a.general.settled,
        profit_net: round1(a.general.totalProfit),
        roi_pct: round1(a.general.roi),
        roc_pct: round1(a.general.roc),
        profit_factor: isFinite(a.general.profitFactor) ? round1(a.general.profitFactor) : null,
        taux_reussite_pct: round1(a.general.hitRate),
        cote_moyenne: round1(a.general.avgOdds),
        mise_moyenne: round1(a.general.avgStake),
        drawdown_max: a.drawdown.amount
      },
      par_sport: slim(a.bySport),
      par_competition: slim(a.byCompetition),
      par_type: slim(a.byType),
      par_tranche_cote: a.byOddsRange.map((r) => ({ tranche: r.name, nb: r.count, roi_pct: round1(r.roi), profit: round1(r.totalProfit) })),
      par_tranche_mise: a.byStakeRange.map((r) => ({ tranche: r.name, nb: r.count, roi_pct: round1(r.roi), profit: round1(r.totalProfit) })),
      par_tipster: slim(a.byTipster),
      par_jour: a.byDay.filter((d) => d.count).map((d) => ({ jour: d.name, nb: d.count, roi_pct: round1(d.roi) })),
      tilt: { taux_pct: round1(a.tilt.rate), evenements: a.tilt.events }
    };
  }

  const round1 = (n) => Math.round(n * 10) / 10;

  return { compute, reviewSummary, block };
})();
