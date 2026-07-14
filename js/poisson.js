/* ==========================================================================
   BetSmart AI — Modèle statistique football (Poisson / Dixon-Coles)
   À partir de la forme réelle (buts marqués/encaissés par match, via api-sports),
   estime des probabilités CALCULÉES pour 1N2, Over/Under 2.5 et BTTS.
   C'est l'ancrage quantitatif du Radar au foot (l'équivalent de l'Elo au tennis) :
   des probabilités issues de données, pas d'une intuition.

   Principe : λ_dom = BASE · attaque_dom · défense_ext · avantage_dom ;
              λ_ext = BASE · attaque_ext · défense_dom.
   Corrélation des faibles scores corrigée par la pondération de Dixon-Coles (ρ).
   Sans dépendance, utilisable navigateur + Node.
   ========================================================================== */
'use strict';

const Poisson = (() => {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const fact = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
  const pmf = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact(k);

  // Correction Dixon-Coles pour les scores faibles (dépendance 0-0/1-0/0-1/1-1)
  const tau = (i, j, lh, la, rho) => {
    if (i === 0 && j === 0) return 1 - lh * la * rho;
    if (i === 0 && j === 1) return 1 + lh * rho;
    if (i === 1 && j === 0) return 1 + la * rho;
    if (i === 1 && j === 1) return 1 - rho;
    return 1;
  };

  // Probabilités à partir des deux buts attendus (λ)
  function fromLambdas(lh, la, opts = {}) {
    const rho = opts.rho != null ? opts.rho : -0.08;
    const MAX = 10;
    let p1 = 0, pX = 0, p2 = 0, over = 0, btts = 0, tot = 0;
    let best = { s: '0-0', p: -1 };
    for (let i = 0; i <= MAX; i++) {
      for (let j = 0; j <= MAX; j++) {
        const p = pmf(i, lh) * pmf(j, la) * tau(i, j, lh, la, rho);
        tot += p;
        if (i > j) p1 += p; else if (i === j) pX += p; else p2 += p;
        if (i + j >= 3) over += p;
        if (i >= 1 && j >= 1) btts += p;
        if (p > best.p) best = { s: `${i}-${j}`, p };
      }
    }
    const r = (x) => Math.round(x / tot * 1000) / 10; // % à 0,1 près
    return {
      lambdaHome: Math.round(lh * 100) / 100,
      lambdaAway: Math.round(la * 100) / 100,
      p1: r(p1), pX: r(pX), p2: r(p2),
      over25: r(over), under25: r(tot - over),
      btts: r(btts), noBtts: r(tot - btts),
      topScore: best.s
    };
  }

  // Estime λ à partir de la forme récente {played, gf, ga} de chaque équipe
  function fromForm(homeForm, awayForm, opts = {}) {
    if (!homeForm || !awayForm || !homeForm.played || !awayForm.played) return null;
    const BASE = opts.base || 1.35;   // buts moyens par équipe et par match
    const HFA = opts.hfa || 1.20;     // avantage du terrain (multiplicatif, domicile)
    const hGF = homeForm.gf / homeForm.played, hGA = homeForm.ga / homeForm.played;
    const aGF = awayForm.gf / awayForm.played, aGA = awayForm.ga / awayForm.played;
    // Forces relatives, bornées pour rester robuste sur petits échantillons (≈6 matchs)
    const hAtt = clamp(hGF / BASE, 0.35, 2.6), hDef = clamp(hGA / BASE, 0.35, 2.6);
    const aAtt = clamp(aGF / BASE, 0.35, 2.6), aDef = clamp(aGA / BASE, 0.35, 2.6);
    const lh = clamp(BASE * hAtt * aDef * HFA, 0.15, 5.5);
    const la = clamp(BASE * aAtt * hDef, 0.15, 5.5);
    const out = fromLambdas(lh, la, opts);
    out.sample = Math.min(homeForm.played, awayForm.played);
    return out;
  }

  // Texte injecté dans le prompt IA (ancrage anti-invention)
  function toText(m, homeName, awayName) {
    if (!m) return '';
    return `## MODÈLE STATISTIQUE (Poisson–Dixon-Coles, calculé sur la forme réelle) :
- Buts attendus : ${homeName} ${m.lambdaHome} – ${awayName} ${m.lambdaAway} (score le + probable ${m.topScore}).
- Probabilités MODÈLE 1N2 : ${homeName} ${m.p1} % / Nul ${m.pX} % / ${awayName} ${m.p2} %.
- Over 2.5 : ${m.over25} % (Under ${m.under25} %). Les deux marquent : ${m.btts} %.
Sers-toi de ces probabilités comme ANCRAGE de départ ; ne t'en écarte qu'avec un fait concret (absence, compo, enjeu, météo). Échantillon : ${m.sample} matchs/équipe (modèle indicatif, pas une certitude).`;
  }

  return { fromForm, fromLambdas, toText };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Poisson;
