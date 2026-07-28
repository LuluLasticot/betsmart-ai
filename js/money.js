/* ==========================================================================
   BetSmart AI — Devises (euro + cryptomonnaies)
   L'app possède UNE devise principale : tous les montants stockés et affichés
   (bankroll, mises, profits, mises conseillées) sont exprimés dedans.
   Chaque bookmaker peut déclarer sa propre devise : elle sert à la SAISIE,
   avec conversion automatique vers la devise principale (cours en direct).
   Cours : api.coinbase.com (public, CORS ouvert), cache 10 min.
   ========================================================================== */
'use strict';

const Money = (() => {
  const CURRENCIES = {
    EUR:  { label: 'Euro',          symbol: '€',    decimals: 2, fiat: true },
    USD:  { label: 'Dollar US',     symbol: '$',    decimals: 2, fiat: true },
    BTC:  { label: 'Bitcoin',       symbol: 'BTC',  decimals: 6 },
    ETH:  { label: 'Ethereum',      symbol: 'ETH',  decimals: 5 },
    SOL:  { label: 'Solana',        symbol: 'SOL',  decimals: 3 },
    USDT: { label: 'Tether',        symbol: 'USDT', decimals: 2 },
    USDC: { label: 'USD Coin',      symbol: 'USDC', decimals: 2 },
    LTC:  { label: 'Litecoin',      symbol: 'LTC',  decimals: 4 },
    XRP:  { label: 'XRP',           symbol: 'XRP',  decimals: 2 },
    DOGE: { label: 'Dogecoin',      symbol: 'DOGE', decimals: 1 },
    BNB:  { label: 'BNB',           symbol: 'BNB',  decimals: 4 },
    TRX:  { label: 'Tron',          symbol: 'TRX',  decimals: 1 }
  };
  const info = (c) => CURRENCIES[c] || CURRENCIES.EUR;
  const isCrypto = (c) => !info(c).fiat;

  let main = 'EUR';      // devise principale (affichage + stockage)
  let showEur = true;    // afficher l'équivalent en euros à côté des cryptos

  /* ---- Cours : 1 unité de <code> = N euros ---- */
  const RATE_KEY = 'betsmart.fxRates';
  const TTL = 10 * 60 * 1000;
  let rates = {};        // { BTC: { eur: 62704.64, at: 1730… } }
  try { rates = JSON.parse(localStorage.getItem(RATE_KEY) || '{}'); } catch (_) { rates = {}; }
  const persist = () => { try { localStorage.setItem(RATE_KEY, JSON.stringify(rates)); } catch (_) {} };

  const fresh = (c) => c === 'EUR' || (rates[c] && Date.now() - rates[c].at < TTL);
  const rateOf = (c) => (c === 'EUR' ? 1 : (rates[c] ? rates[c].eur : null));

  async function fetchRate(code) {
    if (code === 'EUR') return 1;
    if (fresh(code)) return rates[code].eur;
    try {
      const r = await fetch(`https://api.coinbase.com/v2/exchange-rates?currency=${encodeURIComponent(code)}`);
      const j = await r.json();
      const eur = parseFloat(j?.data?.rates?.EUR);
      if (isFinite(eur) && eur > 0) { rates[code] = { eur, at: Date.now() }; persist(); return eur; }
    } catch (_) { /* hors ligne : on garde le dernier cours connu */ }
    return rateOf(code);
  }

  /** Précharge les cours nécessaires (devise principale + devises des books). */
  async function ensureRates(codes) {
    const need = [...new Set([main, ...(codes || [])])].filter((c) => c && c !== 'EUR' && !fresh(c));
    await Promise.all(need.map(fetchRate));
    return true;
  }

  /* ---- Conversion ---- */
  /** Convertit un montant d'une devise vers une autre (pivot : euro). */
  function convert(amount, from, to) {
    const a = Number(amount) || 0;
    const f = from || main, t = to || main;
    if (f === t) return a;
    const rf = rateOf(f), rt = rateOf(t);
    if (!rf || !rt) return null;          // cours inconnu → l'appelant décide
    return (a * rf) / rt;
  }
  const toMain = (amount, from) => convert(amount, from, main);
  const toEur = (amount, from) => convert(amount, from || main, 'EUR');

  /* ---- Formatage ---- */
  function fmt(n, code) {
    const c = code || main;
    const meta = info(c);
    const v = Number(n) || 0;
    if (meta.fiat) {
      return new Intl.NumberFormat('fr-FR', {
        style: 'currency', currency: c,
        maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : meta.decimals
      }).format(v);
    }
    // Crypto : décimales adaptées à l'ordre de grandeur. Une mise de 0,00034 SOL
    // doit rester lisible : on garde toujours ~3 chiffres significatifs.
    const abs = Math.abs(v);
    const dec = abs === 0 ? 2
      : abs >= 1 ? Math.min(meta.decimals, 4)
      : Math.min(8, Math.max(meta.decimals, 2 - Math.floor(Math.log10(abs))));
    const txt = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: dec }).format(v);
    return `${txt} ${meta.symbol}`;
  }
  const fmtSigned = (n, code) => `${(Number(n) || 0) > 0 ? '+' : ''}${fmt(n, code)}`;

  /** Équivalent en euros, quand c'est utile (devise crypto + cours connu). */
  function eurHint(n, code) {
    const c = code || main;
    if (!showEur || c === 'EUR' || !isCrypto(c)) return '';
    const e = toEur(n, c);
    if (e === null || !isFinite(e)) return '';
    const abs = Math.abs(e);
    const txt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: abs >= 100 ? 0 : 2 }).format(e);
    return `≈ ${txt} €`;
  }
  /** Montant + équivalent euro entre parenthèses (ex. « 0,0005 BTC (≈ 38 €) »). */
  function fmtFull(n, code) {
    const h = eurHint(n, code);
    return h ? `${fmt(n, code)} (${h})` : fmt(n, code);
  }

  /* ---- Configuration ---- */
  function setCurrency(code, withEurEquiv) {
    main = CURRENCIES[code] ? code : 'EUR';
    if (withEurEquiv !== undefined) showEur = withEurEquiv !== false;
    if (main !== 'EUR') fetchRate(main);
    return main;
  }

  return {
    CURRENCIES, info, isCrypto,
    get current() { return main; },
    get symbol() { return info(main).symbol; },
    get decimals() { return info(main).decimals; },
    setCurrency, ensureRates, fetchRate, rateOf,
    convert, toMain, toEur,
    fmt, fmtSigned, fmtFull, eurHint
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Money;
