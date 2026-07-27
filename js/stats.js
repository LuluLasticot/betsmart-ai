/* ==========================================================================
   BetSmart AI — Moteur de statistiques
   Profit d'un pari réglé :
     won      → mise × (cote − 1)
     lost     → −mise
     void     → 0
     cashout  → payout − mise
     pending  → non compté (0)
   Transactions : depot / bonus (entrées), retrait (sortie).
   Capital investi (base du ROC) = capital initial + dépôts.
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

  const txSign = (t) => (t.type === 'retrait' ? -1 : 1);
  const txNet = (txs) => txs.reduce((s, t) => s + txSign(t) * (Number(t.amount) || 0), 0);

  /** Filtre par période (nombre de jours, ou 'all'). */
  function inPeriod(items, period) {
    if (period === 'all') return items;
    const from = new Date();
    from.setDate(from.getDate() - Number(period));
    const iso = from.toISOString().slice(0, 10);
    return items.filter((b) => b.date >= iso);
  }

  /** KPIs globaux. */
  function kpis(bets, initialBankroll, txs = []) {
    const counted = bets.filter(isCounted);
    const totalStaked = counted.reduce((s, b) => s + Number(b.stake || 0), 0);
    const totalProfit = counted.reduce((s, b) => s + profit(b), 0);
    const won = bets.filter((b) => b.status === 'won').length;
    const lost = bets.filter((b) => b.status === 'lost').length;
    const pending = bets.filter((b) => b.status === 'pending');
    const pendingStake = pending.reduce((s, b) => s + Number(b.stake || 0), 0);
    const settledCount = won + lost;

    const deposits = txs.filter((t) => t.type === 'depot').reduce((s, t) => s + Number(t.amount || 0), 0);
    const bonus = txs.filter((t) => t.type === 'bonus').reduce((s, t) => s + Number(t.amount || 0), 0);
    const withdrawals = txs.filter((t) => t.type === 'retrait').reduce((s, t) => s + Number(t.amount || 0), 0);
    const invested = initialBankroll + deposits;

    return {
      bankroll: initialBankroll + deposits + bonus - withdrawals + totalProfit,
      profit: totalProfit,
      roi: totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0,
      roc: invested > 0 ? (totalProfit / invested) * 100 : 0,
      hitRate: settledCount > 0 ? (won / settledCount) * 100 : 0,
      won, lost,
      totalStaked,
      pendingCount: pending.length,
      pendingStake,
      avgOdds: counted.length ? counted.reduce((s, b) => s + Number(b.odds || 0), 0) / counted.length : 0,
      avgStake: counted.length ? totalStaked / counted.length : 0,
      count: bets.length,
      deposits, withdrawals, bonus, invested
    };
  }

  /** Série d'évolution de la bankroll : paris réglés + mouvements, en ordre chronologique. */
  function bankrollSeries(bets, initialBankroll, txs = []) {
    const events = [
      ...bets.filter(isCounted).map((b) => ({ date: b.date, createdAt: b.createdAt || 0, delta: profit(b), label: b.event })),
      ...txs.map((t) => ({
        date: t.date, createdAt: t.createdAt || 0,
        delta: txSign(t) * (Number(t.amount) || 0),
        label: `${t.type === 'depot' ? 'Dépôt' : t.type === 'retrait' ? 'Retrait' : 'Bonus'}${t.bookmaker ? ' ' + t.bookmaker : ''}`
      }))
    ].sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : a.createdAt - b.createdAt));

    let running = initialBankroll;
    const points = [{ x: events.length ? events[0].date : new Date().toISOString().slice(0, 10), y: initialBankroll, label: 'Départ' }];
    for (const e of events) {
      running += e.delta;
      points.push({ x: e.date, y: Math.round(running * 100) / 100, label: e.label });
    }
    return points;
  }

  /** Drawdown maximal (pire chute depuis un sommet) sur une série de points {y}. */
  function maxDrawdown(points) {
    let peak = -Infinity, maxDd = 0, maxDdPct = 0;
    for (const p of points) {
      if (p.y > peak) peak = p.y;
      const dd = peak - p.y;
      if (dd > maxDd) {
        maxDd = dd;
        maxDdPct = peak > 0 ? (dd / peak) * 100 : 0;
      }
    }
    return { amount: Math.round(maxDd * 100) / 100, pct: Math.round(maxDdPct * 10) / 10 };
  }

  /** Agrégats par dimension (sport, bookmaker, betType, tipster…). */
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

  /** Performance par tranche de cotes. */
  const ODDS_BUCKETS = [
    { label: '1,01 – 1,50', min: 1, max: 1.5 },
    { label: '1,50 – 2,00', min: 1.5, max: 2 },
    { label: '2,00 – 3,00', min: 2, max: 3 },
    { label: '3,00 et +', min: 3, max: Infinity }
  ];

  function oddsBreakdown(bets) {
    return ODDS_BUCKETS.map((bucket) => {
      const own = bets.filter((b) => isCounted(b) && Number(b.odds) >= bucket.min && Number(b.odds) < bucket.max);
      const staked = own.reduce((s, b) => s + Number(b.stake || 0), 0);
      const pl = own.reduce((s, b) => s + profit(b), 0);
      const won = own.filter((b) => b.status === 'won').length;
      const lost = own.filter((b) => b.status === 'lost').length;
      return {
        label: bucket.label, count: own.length, staked, profit: pl,
        roi: staked > 0 ? (pl / staked) * 100 : 0,
        hitRate: won + lost > 0 ? (won / (won + lost)) * 100 : 0
      };
    }).filter((b) => b.count > 0);
  }

  /** Profit mois par mois (12 derniers mois avec activité). */
  function monthlyProfit(bets) {
    const map = new Map();
    for (const b of bets.filter(isCounted)) {
      const month = (b.date || '').slice(0, 7);
      if (!month) continue;
      map.set(month, (map.get(month) || 0) + profit(b));
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] > b[0] ? 1 : -1))
      .slice(-12)
      .map(([month, pl]) => ({ month, profit: Math.round(pl * 100) / 100 }));
  }

  /** Détail par bookmaker : capital de départ + mouvements + P/L propres. */
  function bookmakerBreakdown(bets, bookrolls = [], txs = []) {
    const initials = new Map(bookrolls.map((b) => [b.name.trim(), Number(b.initial) || 0]));
    const names = new Set([
      ...initials.keys(),
      ...bets.map((b) => (b.bookmaker || '').trim()).filter(Boolean),
      ...txs.map((t) => (t.bookmaker || '').trim()).filter(Boolean)
    ]);

    return [...names].map((name) => {
      const own = bets.filter((b) => (b.bookmaker || '').trim() === name);
      const ownTx = txs.filter((t) => (t.bookmaker || '').trim() === name);
      const counted = own.filter(isCounted);
      const staked = counted.reduce((s, b) => s + Number(b.stake || 0), 0);
      const pl = counted.reduce((s, b) => s + profit(b), 0);
      const moves = txNet(ownTx);
      const pendingStake = own.filter((b) => b.status === 'pending').reduce((s, b) => s + Number(b.stake || 0), 0);
      const initial = initials.get(name) ?? 0;
      return {
        name, initial, staked, profit: pl, moves, pendingStake,
        count: own.length,
        roi: staked > 0 ? (pl / staked) * 100 : 0,
        bankroll: initial + moves + pl,
        hasInitial: initials.has(name)
      };
    }).sort((a, b) => b.bankroll - a.bankroll);
  }

  /** Détection de tilt : mise anormalement grosse juste après des pertes. */
  function tiltCheck(bets, newBet) {
    const settled = bets.filter(isCounted).slice(0, 10); // les 10 derniers (liste triée décroissante)
    if (settled.length < 4) return null;
    const avgStake = settled.reduce((s, b) => s + Number(b.stake || 0), 0) / settled.length;
    const lastTwo = settled.slice(0, 2);
    const consecutiveLosses = lastTwo.every((b) => b.status === 'lost');
    if (consecutiveLosses && Number(newBet.stake) >= avgStake * 1.8) {
      return `Mise de ${Math.round(newBet.stake)} € après 2 pertes de suite (votre mise moyenne : ${Math.round(avgStake)} €). Attention au tilt — les pros gardent une mise stable.`;
    }
    return null;
  }

  /** Résumé compact envoyé au Coach IA (jamais de données personnelles). */
  function coachSummary(bets, initialBankroll, txs = []) {
    const k = kpis(bets, initialBankroll, txs);
    const dd = maxDrawdown(bankrollSeries(bets, initialBankroll, txs));
    const combined = bets.filter((b) => isCounted(b) && b.betType === 'combine');
    const combinedLong = combined.filter((b) => Number(b.legs || 0) >= 3);
    return {
      global: {
        nb_paris_regles: k.won + k.lost,
        roi_pct: round1(k.roi),
        roc_pct: round1(k.roc),
        taux_reussite_pct: round1(k.hitRate),
        profit_net: round1(k.profit),
        capital_investi: round1(k.invested),
        bankroll_actuelle: round1(k.bankroll),
        cote_moyenne: round1(k.avgOdds),
        mise_moyenne: round1(k.avgStake),
        drawdown_max: dd.amount,
        drawdown_max_pct: dd.pct
      },
      par_sport: groupBy(bets, 'sport').map(slim),
      par_bookmaker: groupBy(bets, 'bookmaker').map(slim),
      par_type: groupBy(bets, 'betType').map(slim),
      par_tipster: groupBy(bets.filter((b) => b.tipster), 'tipster').map(slim),
      par_tranche_de_cote: oddsBreakdown(bets).map((b) => ({ tranche: b.label, nb: b.count, roi_pct: round1(b.roi), profit: round1(b.profit) })),
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

  /* ---- Formatage ---- */
  // Formatage délégué au module Devises (euro ou crypto selon le réglage).
  const fmtMoney = (n) => (typeof Money !== 'undefined'
    ? Money.fmt(n)
    : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n));
  const fmtPct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)} %`;
  const fmtSigned = (n) => `${n > 0 ? '+' : ''}${fmtMoney(n)}`;

  return {
    profit, isSettled, isCounted, inPeriod, kpis, bankrollSeries, maxDrawdown,
    groupBy, oddsBreakdown, monthlyProfit, bookmakerBreakdown, tiltCheck, coachSummary,
    fmtMoney, fmtPct, fmtSigned
  };
})();
