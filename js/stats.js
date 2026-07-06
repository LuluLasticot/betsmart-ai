/* ==========================================================================
   BetSmart AI — Moteur de statistiques
   Profit d'un pari réglé :
     won      → mise × (cote − 1)
     lost     → −mise
     void     → 0
     cashout  → payout − mise
     pending  → non compté (0)
   ========================================================================== */
'use strict';

const Stats = (() => {

  function profit(bet) {
    const stake = Number(bet.stake) || 0;
    const odds = Number(bet.odds) || 0;
    switch (bet.status) {
      case 'won': return stake * (odds - 1);
      case 'lost': return -stake;
      case 'cashout': return (Number(bet.payout) || 0) - stake;
      default: return 0; // pending, void
    }
  }

  const isSettled = (b) => b.status !== 'pending';
  const isCounted = (b) => b.status === 'won' || b.status === 'lost' || b.status === 'cashout';

  /** Filtre par période (nombre de jours, ou 'all'). */
  function inPeriod(bets, period) {
    if (period === 'all') return bets;
    const from = new Date();
    from.setDate(from.getDate() - Number(period));
    const iso = from.toISOString().slice(0, 10);
    return bets.filter((b) => b.date >= iso);
  }

  /** KPIs globaux. */
  function kpis(bets, initialBankroll) {
    const counted = bets.filter(isCounted);
    const totalStaked = counted.reduce((s, b) => s + Number(b.stake || 0), 0);
    const totalProfit = counted.reduce((s, b) => s + profit(b), 0);
    const won = bets.filter((b) => b.status === 'won').length;
    const lost = bets.filter((b) => b.status === 'lost').length;
    const pending = bets.filter((b) => b.status === 'pending');
    const pendingStake = pending.reduce((s, b) => s + Number(b.stake || 0), 0);
    const settledCount = won + lost;

    return {
      bankroll: initialBankroll + totalProfit,
      profit: totalProfit,
      roi: totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0,
      roc: initialBankroll > 0 ? (totalProfit / initialBankroll) * 100 : 0,
      hitRate: settledCount > 0 ? (won / settledCount) * 100 : 0,
      won, lost,
      totalStaked,
      pendingCount: pending.length,
      pendingStake,
      avgOdds: counted.length ? counted.reduce((s, b) => s + Number(b.odds || 0), 0) / counted.length : 0,
      avgStake: counted.length ? totalStaked / counted.length : 0,
      count: bets.length
    };
  }

  /** Série d'évolution de la bankroll (points datés, ordre chronologique). */
  function bankrollSeries(bets, initialBankroll) {
    const settled = bets.filter(isCounted)
      .slice()
      .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : (a.createdAt || 0) - (b.createdAt || 0)));

    let running = initialBankroll;
    const points = [{ x: settled.length ? settled[0].date : new Date().toISOString().slice(0, 10), y: initialBankroll, label: 'Départ' }];
    for (const b of settled) {
      running += profit(b);
      points.push({ x: b.date, y: Math.round(running * 100) / 100, label: b.event });
    }
    return points;
  }

  /** Agrégats par dimension (sport, bookmaker, betType…). */
  function groupBy(bets, key) {
    const map = new Map();
    for (const b of bets.filter(isCounted)) {
      const k = (b[key] || 'Autre').trim() || 'Autre';
      if (!map.has(k)) map.set(k, { name: k, staked: 0, profit: 0, count: 0, won: 0, lost: 0 });
      const g = map.get(k);
      g.staked += Number(b.stake || 0);
      g.profit += profit(b);
      g.count += 1;
      if (b.status === 'won') g.won += 1;
      if (b.status === 'lost') g.lost += 1;
    }
    return [...map.values()]
      .map((g) => ({ ...g, roi: g.staked > 0 ? (g.profit / g.staked) * 100 : 0 }))
      .sort((a, b) => b.staked - a.staked);
  }

  /** Résumé compact envoyé au Coach IA (jamais de données personnelles). */
  function coachSummary(bets, initialBankroll) {
    const k = kpis(bets, initialBankroll);
    const combined = bets.filter((b) => isCounted(b) && b.betType === 'combine');
    const combinedLong = combined.filter((b) => Number(b.legs || 0) >= 3);
    return {
      global: {
        nb_paris_regles: k.won + k.lost,
        roi_pct: round1(k.roi),
        roc_pct: round1(k.roc),
        taux_reussite_pct: round1(k.hitRate),
        profit_net: round1(k.profit),
        bankroll_initiale: initialBankroll,
        bankroll_actuelle: round1(k.bankroll),
        cote_moyenne: round1(k.avgOdds),
        mise_moyenne: round1(k.avgStake)
      },
      par_sport: groupBy(bets, 'sport').map(slim),
      par_bookmaker: groupBy(bets, 'bookmaker').map(slim),
      par_type: groupBy(bets, 'betType').map(slim),
      combines: {
        nb: combined.length,
        profit: round1(combined.reduce((s, b) => s + profit(b), 0)),
        nb_3_selections_ou_plus: combinedLong.length,
        profit_3_selections_ou_plus: round1(combinedLong.reduce((s, b) => s + profit(b), 0))
      }
    };

    function slim(g) {
      return { nom: g.name, nb: g.count, mise_totale: round1(g.staked), profit: round1(g.profit), roi_pct: round1(g.roi) };
    }
  }

  const round1 = (n) => Math.round(n * 10) / 10;

  /** Détail par bookmaker : capital de départ + P/L propre à chaque book. */
  function bookmakerBreakdown(bets, bookrolls = []) {
    const initials = new Map(bookrolls.map((b) => [b.name.trim(), Number(b.initial) || 0]));
    const names = new Set([...initials.keys(), ...bets.map((b) => (b.bookmaker || '').trim()).filter(Boolean)]);

    return [...names].map((name) => {
      const own = bets.filter((b) => (b.bookmaker || '').trim() === name);
      const counted = own.filter(isCounted);
      const staked = counted.reduce((s, b) => s + Number(b.stake || 0), 0);
      const pl = counted.reduce((s, b) => s + profit(b), 0);
      const pendingStake = own.filter((b) => b.status === 'pending').reduce((s, b) => s + Number(b.stake || 0), 0);
      const initial = initials.get(name) ?? 0;
      return {
        name, initial, staked, profit: pl, pendingStake,
        count: own.length,
        roi: staked > 0 ? (pl / staked) * 100 : 0,
        bankroll: initial + pl,
        hasInitial: initials.has(name)
      };
    }).sort((a, b) => b.bankroll - a.bankroll);
  }

  /* ---- Formatage ---- */
  const fmtMoney = (n) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n);
  const fmtPct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)} %`;
  const fmtSigned = (n) => `${n > 0 ? '+' : ''}${fmtMoney(n)}`;

  return { profit, isSettled, isCounted, inPeriod, kpis, bankrollSeries, groupBy, bookmakerBreakdown, coachSummary, fmtMoney, fmtPct, fmtSigned };
})();
