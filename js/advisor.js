/* ==========================================================================
   BetSmart AI — Radar IA (suggestions de paris "value")
   Pipeline :
     1. Gemini + Google Search grounding : recherche factuelle (matchs, news,
        blessures, forme, cotes) → détection de value bets → JSON
     2. Le CLIENT calcule la mise (Kelly fractionné plafonné) : jamais le LLM.
   Principe directeur du prompt : mieux vaut 0 pick qu'un mauvais pick.
   ========================================================================== */
'use strict';

const Advisor = (() => {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

  /* ------------------------------------------------------------------
     Le prompt expert
     ------------------------------------------------------------------ */
  function buildPrompt(ctx) {
    return `# RÔLE

Tu es un analyste quantitatif senior spécialisé dans le value betting sportif. Tu travailles comme le ferait un syndicat de paris professionnel : tu ne cherches pas des "pronostics probables", tu cherches des COTES MAL PRICÉES — des écarts entre la probabilité réelle d'un événement et la probabilité implicite de sa cote. Tu sais qu'un parieur qui joue sans value perd à long terme quelle que soit sa réussite apparente, et que l'abstention est une décision professionnelle respectable.

# MISSION

Identifier au maximum 3 value bets sur les ${ctx.horizon} prochaines heures, dans ce périmètre :
- Sports : ${ctx.sports}
- Bookmakers français de référence pour les cotes : ${ctx.bookmakers}
- Date et heure actuelles : ${ctx.now} (Europe/Paris)

# MÉTHODOLOGIE OBLIGATOIRE (dans cet ordre, via Google Search)

1. **Inventaire** — Recherche les rencontres réellement programmées dans le périmètre (compétitions majeures et liquides en priorité). Vérifie la date et l'heure de chaque match candidat. Un match non confirmé par ta recherche est ÉLIMINÉ.
2. **Enquête par candidat** — Pour chaque match retenu, recherche activement :
   - actualités des dernières 48 h : blessures, suspensions, compositions probables, turnover annoncé ;
   - forme récente (5 derniers matchs) et dynamique réelle (pas seulement les résultats : contexte, adversité) ;
   - enjeu sportif (course au titre, maintien, match sans enjeu, coupe vs championnat) ;
   - calendrier et fatigue (match européen 3 jours avant, déplacement, prolongations récentes) ;
   - confrontations directes si structurellement pertinentes ;
   - météo/surface si le sport y est sensible (tennis, football).
3. **Estimation** — Estime la probabilité réelle de l'issue visée (\`probabilite\`, entre 0 et 1). Sois calibré : ta probabilité doit refléter ton incertitude réelle, pas ta conviction. Retire la marge du bookmaker avant toute comparaison (les probabilités implicites d'un marché somment à ~105-108 %).
4. **Cote du marché** — Recherche la cote actuellement proposée. Si tu ne trouves pas de cote récente et fiable, marque \`cote_verifiee: false\` et donne ta meilleure estimation prudente.
5. **Calcul de la value** — value = (probabilite × cote) − 1. Ne retiens un pick QUE si value ≥ 0,05 (5 %) avec une cote vérifiée, ou ≥ 0,08 si la cote est estimée.
6. **Sélection finale** — Classe par (value × confiance) et garde les 3 meilleurs maximum. Un seul pick par match.

# RÈGLES STRICTES

- **Zéro invention** : chaque match, chaque fait d'analyse et chaque cote doivent provenir de tes recherches. Cite tes sources (nom du site + ce que tu y as vérifié).
- **Marchés liquides uniquement** : 1N2, double chance, over/under buts ou points, handicap, vainqueur de match. Jamais de buteurs, cartons, corners ou marchés exotiques (données insuffisantes, marges énormes).
- **Paris simples uniquement** : jamais de combinés — multiplier les sélections multiplie la marge du bookmaker.
- **Éviter** : cotes < 1,40 (value quasi impossible après marge) et > 4,50 (variance excessive, probabilités difficiles à calibrer) ; matchs amicaux ; compétitions de jeunes ou mineures.
- **Calibration de la confiance** (échelle 1-5) : 5 = information forte et convergente (ex. : absence majeure confirmée non intégrée dans la cote) ; 3 = analyse solide mais facteurs contradictoires ; 1-2 = ne pas proposer le pick.
- **Abstention** : si après recherche aucun pari n'atteint le seuil de value, renvoie \`"picks": []\` avec une explication dans \`analyse_marche\`. C'est une réponse de haute qualité, pas un échec. NE BAISSE JAMAIS tes standards pour "remplir" la réponse.

# CONTEXTE UTILISATEUR (pour adapter, pas pour flatter)

- Bankroll actuelle : ${ctx.bankroll} €
- Profil de risque déclaré : ${ctx.riskProfile}
- Historique de performance par sport (ROI réel de CE parieur) : ${ctx.userPerf}
La mise sera calculée par l'application (Kelly fractionné) : ne recommande JAMAIS de montant de mise. Si l'historique montre un ROI très négatif du parieur sur un sport, tu peux le signaler dans \`risques\` du pick concerné.

# FORMAT DE SORTIE

Réponds en terminant par un unique bloc \`\`\`json contenant exactement cette structure :

\`\`\`json
{
  "analyse_marche": "2-3 phrases : état du marché sur la période, pourquoi ces picks (ou pourquoi aucun).",
  "picks": [
    {
      "sport": "Football",
      "competition": "Liga",
      "match": "Villarreal – Osasuna",
      "date_match": "YYYY-MM-DD",
      "heure_match": "HH:MM",
      "marche": "1N2",
      "selection": "Victoire Villarreal",
      "cote": 1.85,
      "cote_verifiee": true,
      "bookmaker": "Winamax",
      "probabilite": 0.60,
      "value_pct": 11.0,
      "confiance": 4,
      "analyse": "3-5 phrases factuelles : les éléments recherchés qui justifient l'écart entre ta probabilité et la cote.",
      "risques": "1-2 phrases : ce qui pourrait invalider l'analyse.",
      "sources": ["nomdusite.com — compositions probables", "nomdusite.com — cote consultée"]
    }
  ]
}
\`\`\`

Vérifications finales avant de répondre : chaque \`value_pct\` correspond bien à (probabilite × cote − 1) × 100 ; chaque match a une date dans la fenêtre demandée ; aucune cote inventée.`;
  }

  /* ------------------------------------------------------------------
     Appel Gemini avec Google Search grounding
     (le grounding est incompatible avec le mode JSON strict → on
     demande un bloc \`\`\`json et on parse de façon robuste)
     ------------------------------------------------------------------ */
  async function suggest(apiKey, model, ctx) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: buildPrompt(ctx) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.25 }
    };

    const res = await fetch(`${BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Erreur API (${res.status})`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text) throw new Error('Réponse vide du modèle.');

    const parsed = extractJSON(text);
    if (!parsed || !Array.isArray(parsed.picks)) throw new Error('Réponse du modèle illisible — réessayez.');

    // Filet de sécurité côté client : recalcul de la value + filtres durs
    parsed.picks = parsed.picks
      .filter((p) => p && typeof p.cote === 'number' && typeof p.probabilite === 'number')
      .map((p) => {
        const value = p.probabilite * p.cote - 1;
        return { ...p, value_pct: Math.round(value * 1000) / 10 };
      })
      .filter((p) => {
        const seuil = p.cote_verifiee === false ? 0.08 : 0.05;
        return p.probabilite > 0 && p.probabilite < 1
          && p.cote >= 1.3 && p.cote <= 5
          && (p.probabilite * p.cote - 1) >= seuil
          && (p.confiance || 0) >= 3;
      })
      .slice(0, 3);

    return parsed;
  }

  function extractJSON(text) {
    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    const candidates = [];
    if (fenced) candidates.push(fenced[1]);
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
    for (const c of candidates) {
      try { return JSON.parse(c); } catch (_) { /* essai suivant */ }
    }
    return null;
  }

  /* ------------------------------------------------------------------
     Gestion de bankroll : Kelly fractionné plafonné par profil
     kelly = (cote × p − 1) / (cote − 1) ; mise = bankroll × min(kelly × fraction, plafond)
     ------------------------------------------------------------------ */
  const PROFILES = {
    prudent:   { cap: 0.010, kellyFraction: 0.20, label: 'Prudent (max 1 % de la bankroll)' },
    equilibre: { cap: 0.020, kellyFraction: 0.25, label: 'Équilibré (max 2 % de la bankroll)' },
    agressif:  { cap: 0.030, kellyFraction: 0.33, label: 'Agressif (max 3 % de la bankroll)' }
  };

  function stakeFor(bankroll, pick, profileKey) {
    const profile = PROFILES[profileKey] || PROFILES.equilibre;
    const b = pick.cote - 1;
    if (b <= 0 || bankroll <= 0) return { stake: 0, pctBankroll: 0, kelly: 0 };

    const p = pick.probabilite;
    const fullKelly = (pick.cote * p - 1) / b;      // fraction optimale théorique
    if (fullKelly <= 0) return { stake: 0, pctBankroll: 0, kelly: 0 };

    let fraction = fullKelly * profile.kellyFraction; // Kelly fractionné : réduit drastiquement le risque de ruine
    if (pick.cote_verifiee === false) fraction *= 0.5; // cote non vérifiée → demi-mise
    fraction = Math.min(fraction, profile.cap);

    const stake = Math.max(0, Math.floor(bankroll * fraction * 2) / 2); // arrondi à 0,50 €
    return {
      stake,
      pctBankroll: Math.round(fraction * 1000) / 10,
      kelly: Math.round(fullKelly * 1000) / 10
    };
  }

  return { suggest, stakeFor, PROFILES };
})();
