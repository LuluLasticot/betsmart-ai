/* ==========================================================================
   BetSmart AI — Radar IA v2
   Pipeline en deux passes :
     Passe 1 (inventaire)  : recherche des matchs réels de la fenêtre → shortlist
     Passe 2 (enquête)     : investigation approfondie de la shortlist → picks
   + Boucle de feedback    : les picks passés (réglés) sont réinjectés dans le
     prompt pour corriger la calibration du modèle au fil du temps.
   + Anti-doublons         : les matchs déjà pariés sont exclus.
   + Analyse d'un match précis (tous les marchés principaux).
   La mise reste calculée côté client (Kelly fractionné plafonné).
   ========================================================================== */
'use strict';

const Advisor = (() => {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

  /* ------------------------------------------------------------------
     Appel Gemini avec grounding + retry sur erreurs transitoires
     ------------------------------------------------------------------ */
  async function callGemini(apiKey, model, prompt, { temperature = 0.25, retries = 2 } = {}) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature }
    };

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
        if (!text) throw new Error('Réponse vide du modèle.');
        return text;
      }

      // 429 (quota) et 503 (surcharge) : on attend puis on réessaie
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `Erreur API (${res.status})`;
      throw new Error(res.status === 429 ? 'Quota API atteint — patientez une minute puis réessayez.' : msg);
    }
  }

  function extractJSON(text) {
    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    const candidates = [];
    if (fenced) candidates.push(fenced[1]);
    for (const open of ['{', '[']) {
      const close = open === '{' ? '}' : ']';
      const first = text.indexOf(open);
      const last = text.lastIndexOf(close);
      if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
    }
    for (const c of candidates) {
      try { return JSON.parse(c); } catch (_) { /* essai suivant */ }
    }
    return null;
  }

  /* ------------------------------------------------------------------
     Boucle de feedback : bilan des picks passés injecté dans le prompt
     ------------------------------------------------------------------ */
  function feedbackBlock(picks) {
    const settled = picks.filter((p) => p.result === 'won' || p.result === 'lost');
    if (settled.length < 5) return '';

    const stats = radarStats(picks);
    const bySport = new Map();
    for (const p of settled) {
      const s = bySport.get(p.sport) || { n: 0, won: 0, pl: 0 };
      s.n++; if (p.result === 'won') { s.won++; s.pl += p.cote - 1; } else { s.pl -= 1; }
      bySport.set(p.sport, s);
    }
    const sportLines = [...bySport.entries()]
      .filter(([, s]) => s.n >= 3)
      .map(([sport, s]) => `- ${sport} : ${s.won}/${s.n} gagnés, ${s.pl >= 0 ? '+' : ''}${s.pl.toFixed(1)} unités`)
      .join('\n');

    return `
# RETOUR D'EXPÉRIENCE SUR TES PRÉCÉDENTES ANALYSES (à intégrer sérieusement)

Sur tes ${settled.length} derniers picks réglés :
- Probabilité moyenne annoncée : ${stats.avgPredicted} % — taux de réussite réel : ${stats.actualWinRate} %.
${stats.calibrationGap > 5 ? `- Tu SURESTIMES tes probabilités de ${stats.calibrationGap} points en moyenne : sois plus conservateur, révise tes probabilités À LA BAISSE et exige plus de value.` : stats.calibrationGap < -5 ? `- Tu sous-estimes tes probabilités de ${Math.abs(stats.calibrationGap)} points : tu peux être légèrement plus assertif.` : '- Ta calibration est correcte : maintiens cette rigueur.'}
- ROI théorique à mise constante : ${stats.flatRoi} %.
${sportLines ? `Par sport :\n${sportLines}\nÉvite de proposer des picks dans les segments où ton bilan est nettement négatif, sauf signal exceptionnellement fort.` : ''}`;
  }

  /* ------------------------------------------------------------------
     Passe 1 — Inventaire et shortlist
     ------------------------------------------------------------------ */
  function pass1Prompt(ctx) {
    return `Tu es l'assistant de recherche d'un analyste de paris sportifs professionnel.

# MISSION (rapide et factuelle)
Via Google Search, dresse l'inventaire des rencontres RÉELLEMENT programmées dans les ${ctx.horizon} prochaines heures (date/heure actuelles : ${ctx.now}, Europe/Paris) pour : ${ctx.sports}.
Priorise les compétitions majeures et liquides (grands championnats, coupes d'Europe, ATP/WTA, NBA, playoffs…). Ignore : matchs amicaux, jeunes, compétitions mineures.

${ctx.excluded.length ? `# MATCHS À EXCLURE (l'utilisateur a déjà un pari dessus)\n${ctx.excluded.map((e) => `- ${e}`).join('\n')}\n` : ''}
# SÉLECTION
Retiens les 5 à 6 rencontres les PLUS PROMETTEUSES pour la recherche de value : contexte particulier (absences signalées, rotation probable, enjeu asymétrique, série en cours, derby émotionnel…). La promesse de value vient d'une information que le marché pourrait mal intégrer, pas de la notoriété du match.

Termine par un unique bloc \`\`\`json :
\`\`\`json
{"candidats": [{"sport": "...", "competition": "...", "match": "Équipe A – Équipe B", "date": "YYYY-MM-DD", "heure": "HH:MM", "angle": "1 phrase : pourquoi ce match peut receler de la value"}]}
\`\`\`
Chaque match doit avoir été vérifié par ta recherche (date exacte). Si aucun match dans la fenêtre, renvoie {"candidats": []}.`;
  }

  /* ------------------------------------------------------------------
     Passe 2 — Enquête approfondie sur la shortlist
     ------------------------------------------------------------------ */
  function pass2Prompt(ctx, candidats) {
    return `# RÔLE

Tu es un analyste quantitatif senior spécialisé dans le value betting sportif. Tu travailles comme un syndicat de paris professionnel : tu cherches des COTES MAL PRICÉES — des écarts entre la probabilité réelle et la probabilité implicite de la cote. L'abstention est une décision professionnelle respectable : mieux vaut 0 pick qu'un pick sans avantage.
${ctx.feedback}

# SHORTLIST À ENQUÊTER (matchs déjà vérifiés — n'en ajoute AUCUN autre)
${JSON.stringify(candidats, null, 2)}

# ENQUÊTE OBLIGATOIRE, match par match (via Google Search)
1. Actualités < 48 h : blessures, suspensions, compositions probables, turnover annoncé, déclarations d'entraîneur.
2. Forme réelle des 5 derniers matchs (contexte et adversité, pas seulement les résultats).
3. Enjeu (titre, maintien, match sans enjeu, priorité coupe/championnat) et calendrier/fatigue (match européen récent, déplacement, prolongations).
4. Confrontations directes si structurellement pertinentes ; météo/surface si le sport y est sensible.
5. Cote actuelle du marché chez ${ctx.bookmakers}. Si introuvable de source récente → "cote_verifiee": false.

# ESTIMATION ET SÉLECTION
- Estime la probabilité réelle de l'issue (calibrée : elle doit refléter ton incertitude, pas ta conviction). Retire la marge du bookmaker (~5-8 %) avant comparaison.
- value = (probabilite × cote) − 1. Seuils : ≥ 0,05 si cote vérifiée, ≥ 0,08 sinon.
- Marchés liquides uniquement (1N2, double chance, over/under, handicap, vainqueur). Paris SIMPLES uniquement. Cotes entre 1,40 et 4,50.
- Confiance 1-5 (5 = information forte convergente non intégrée dans la cote ; < 3 = ne pas proposer).
- Maximum 3 picks, un seul par match, classés par (value × confiance). Si rien ne passe les seuils : "picks": [] avec explication.

# CONTEXTE UTILISATEUR (pour information, ne recommande jamais de montant de mise)
- Bankroll : ${ctx.bankroll} € · Profil : ${ctx.riskProfile}
- Son historique par sport : ${ctx.userPerf}
- Exposition en cours : ${ctx.exposure}

# FORMAT DE SORTIE — termine par un unique bloc \`\`\`json :
\`\`\`json
{
  "analyse_marche": "2-3 phrases : état du marché, pourquoi ces picks (ou aucun).",
  "picks": [
    {
      "sport": "Football", "competition": "Liga", "match": "…", "date_match": "YYYY-MM-DD", "heure_match": "HH:MM",
      "marche": "1N2", "selection": "…", "cote": 1.85, "cote_verifiee": true, "bookmaker": "…",
      "probabilite": 0.60, "value_pct": 11.0, "confiance": 4,
      "analyse": "3-5 phrases factuelles issues de ta recherche.",
      "risques": "1-2 phrases : ce qui invaliderait l'analyse.",
      "sources": ["site — ce qui a été vérifié"]
    }
  ]
}
\`\`\`
Vérifications finales : value_pct = (probabilite × cote − 1) × 100 ; dates dans la fenêtre ; aucune cote inventée.`;
  }

  /* ------------------------------------------------------------------
     Analyse d'un match précis (tous les marchés principaux)
     ------------------------------------------------------------------ */
  function matchPrompt(ctx, query) {
    return `Tu es un analyste quantitatif senior en value betting. Date/heure actuelles : ${ctx.now} (Europe/Paris).
${ctx.feedback}

# MISSION
L'utilisateur veut une analyse complète de : « ${query} »

1. Identifie précisément la rencontre via Google Search (équipes/joueurs, compétition, date, heure). Si introuvable ou ambiguë, dis-le.
2. Enquête approfondie : blessures/suspensions/compos (< 48 h), forme réelle, enjeu, fatigue/calendrier, H2H pertinents, météo/surface si sensible.
3. Pour CHAQUE marché principal (1N2 ou vainqueur, double chance si pertinent, over/under principal, handicap principal) : estime la probabilité calibrée, trouve la cote actuelle chez ${ctx.bookmakers}, calcule value = (probabilite × cote) − 1.
4. Verdict global : le meilleur angle s'il existe (value ≥ 5 %), ou "à éviter" si rien ne se dégage — dis-le franchement.

Termine par un unique bloc \`\`\`json :
\`\`\`json
{
  "match": "…", "sport": "…", "competition": "…", "date_match": "YYYY-MM-DD", "heure_match": "HH:MM",
  "trouve": true,
  "verdict": "a_jouer" | "a_eviter",
  "resume": "3-4 phrases : lecture globale du match, information clé.",
  "marches": [
    {"marche": "1N2", "selection": "…", "cote": 1.85, "cote_verifiee": true, "bookmaker": "…", "probabilite": 0.55, "value_pct": 1.8, "avis": "1 phrase"}
  ],
  "meilleur_marche": "libellé du marché retenu ou null",
  "risques": "1-2 phrases.",
  "sources": ["site — ce qui a été vérifié"]
}
\`\`\`
Ne force JAMAIS un verdict "a_jouer" : la plupart des matchs ne présentent aucune value exploitable.`;
  }

  /* ------------------------------------------------------------------
     Orchestration
     ------------------------------------------------------------------ */
  function validatePicks(picks) {
    return (picks || [])
      .filter((p) => p && typeof p.cote === 'number' && typeof p.probabilite === 'number')
      .map((p) => ({ ...p, value_pct: Math.round((p.probabilite * p.cote - 1) * 1000) / 10 }))
      .filter((p) => {
        const seuil = p.cote_verifiee === false ? 0.08 : 0.05;
        return p.probabilite > 0 && p.probabilite < 1
          && p.cote >= 1.3 && p.cote <= 5
          && (p.probabilite * p.cote - 1) >= seuil
          && (p.confiance || 0) >= 3;
      })
      .slice(0, 3);
  }

  /* ------------------------------------------------------------------
     Radar sourcé coteur : les matchs ET les cotes viennent de coteur.com,
     Gemini ne fait qu'analyser et estimer les probabilités.
     ------------------------------------------------------------------ */
  function coteurPrompt(ctx, candidates) {
    return `# RÔLE

Tu es un analyste quantitatif senior spécialisé dans le value betting. Ta force : estimer des probabilités réelles calibrées. Les cotes te sont fournies (elles viennent de coteur.com, fiables) — tu ne les inventes pas.
${ctx.feedback}

# MATCHS RÉELS À ANALYSER (cotes 1N2 réelles issues de coteur.com, meilleur book FR)
${JSON.stringify(candidates, null, 2)}

# TRAVAIL, match par match (via Google Search)
1. Enquête < 48 h : blessures, suspensions, compositions probables, turnover, forme réelle des 5 derniers matchs, enjeu, calendrier/fatigue, H2H pertinents, météo/surface si sensible.
2. Estime la probabilité RÉELLE calibrée de chaque issue (domicile / nul / extérieur). Sois honnête sur ton incertitude.
3. Calcule la value sur les COTES FOURNIES : value = probabilite × cote − 1 (utilise cote_1 pour domicile, cote_N pour nul, cote_2 pour extérieur).
4. Tu peux aussi proposer un Over/Under buts si tu y vois une value nette (la cote sera vérifiée ensuite sur coteur).

# SÉLECTION
- Ne retiens QUE les paris avec value ≥ 5 % sur la cote fournie.
- Cotes entre 1,40 et 4,50. Paris simples uniquement. Confiance 1-5 (< 3 = ne pas proposer).
- Maximum 3 picks, classés par (value × confiance). Si rien ne dépasse le seuil : "picks": [] avec explication. L'abstention est une réponse de qualité.

# CONTEXTE UTILISATEUR
- Bankroll : ${ctx.bankroll} € · Profil : ${ctx.riskProfile}
- Performance passée par sport : ${ctx.userPerf}

# SORTIE — termine par un unique bloc \`\`\`json :
\`\`\`json
{
  "analyse_marche": "2-3 phrases.",
  "picks": [
    {"sport":"Football","competition":"…","match":"Équipe A – Équipe B","date_match":"YYYY-MM-DD","heure_match":"HH:MM",
     "marche":"1N2","selection":"Victoire Équipe A","cote":1.85,"bookmaker":"Winamax","probabilite":0.60,"value_pct":11.0,"confiance":4,
     "analyse":"3-5 phrases factuelles issues de ta recherche.","risques":"1-2 phrases.","sources":["site — ce qui a été vérifié"]}
  ]
}
\`\`\`
Pour un pick 1N2, "cote" DOIT être exactement la cote fournie (cote_1/cote_N/cote_2). "match" DOIT reprendre le libellé exact fourni.`;
  }

  /* ------------------------------------------------------------------
     Radar tous-marchés : Gemini choisit parmi TOUS les marchés coteur
     réellement proposés (chaque option a un id + sa cote réelle).
     ------------------------------------------------------------------ */
  function marketsPrompt(ctx, candidates) {
    return `# RÔLE

Tu es un analyste quantitatif senior en value betting. Ta force : estimer des probabilités réelles calibrées. Les cotes te sont fournies (réelles, coteur.com) — tu ne les inventes pas. Tu analyses TOUS les marchés, pas seulement le 1N2.
${ctx.feedback}

# MATCHS ET MARCHÉS RÉELS
Chaque option a : "id", "cote" (meilleur book FR), "proba_marche_pct" (probabilité JUSTE du marché, dévigorisée de la meilleure ligne mondiale — la meilleure estimation objective disponible), "edge_marche_pct" (avantage brut du prix FR vs marché), "mouvement_pts" (déplacement récent de la ligne en points de proba : POSITIF = la cote baisse, l'argent rentre sur cette issue = signal fort ; NÉGATIF = la cote monte). Chaque marché a "trj_pct" (taux de retour ; plus il est haut, plus la marge est faible et la value trouvable).
${JSON.stringify(candidates, null, 2)}

# MÉTHODE (via Google Search) — ANCRAGE MARCHÉ OBLIGATOIRE
1. Pars TOUJOURS de "proba_marche_pct" comme référence : c'est la probabilité que le marché (books sharp inclus) attribue à l'issue. Le marché a raison la plupart du temps.
2. Enquête < 48 h : blessures, suspensions, compositions, forme réelle, enjeu, calendrier/fatigue, H2H, météo/surface, style, moyennes de buts.
3. Ne t'écarte de proba_marche_pct QUE si tu trouves un fait CONCRET et VÉRIFIÉ que le marché n'a pas encore intégré (ex. absence majeure annoncée après l'ouverture des cotes, turnover confirmé). Sinon, colle au marché.
4. Donne ta probabilité estimée. Elle sera automatiquement mélangée à celle du marché (le marché pèse le plus) — inutile d'être extrême.

# SÉLECTION
- Privilégie les options où "edge_marche_pct" est POSITIF (le book FR offre mieux que le prix juste — vraie value objective) ET où tu confirmes par un fait concret. Un edge marché positif + un "mouvement_pts" positif (la ligne se déplace en ta faveur) + une raison concrète = le meilleur pari possible (tu prends la value AVANT que le marché finisse de corriger).
- Évite les marchés à "trj_pct" faible (grosse marge). Cotes 1,40–5,00. Confiance 1-5 (< 3 = écarter). Max 5 picks, un par match.
- Abstention possible : "picks": [] si rien ne réunit edge marché et raison concrète. C'est une réponse de qualité.

# CONTEXTE UTILISATEUR
Bankroll ${ctx.bankroll} € · Profil ${ctx.riskProfile} · Perf passée : ${ctx.userPerf}

# SORTIE — termine par un unique bloc \`\`\`json :
\`\`\`json
{
  "analyse_marche": "2-3 phrases.",
  "picks": [
    {"option_id":"OU2-5_3","probabilite":0.58,"confiance":4,"analyse":"3-5 phrases factuelles issues de ta recherche.","risques":"1-2 phrases.","sources":["site — vérifié"]}
  ]
}
\`\`\`
"option_id" DOIT être l'un des id fournis. N'invente aucune option ni cote.`;
  }

  async function suggestFromCoteurMarkets(apiKey, model, ctx, candidates, onProgress) {
    if (!candidates.length) {
      return { analyse_marche: 'Aucun match coteur exploitable dans la fenêtre — élargissez la fenêtre ou les sports.', picks: [], raw: true };
    }
    onProgress?.('research', candidates);
    const raw = await callGemini(apiKey, ctx.deepModel || model, marketsPrompt(ctx, candidates), { temperature: 0.25 });
    const parsed = extractJSON(raw);
    if (!parsed || !Array.isArray(parsed.picks)) throw new Error('Réponse du modèle illisible — réessayez.');
    onProgress?.('done');
    return parsed; // picks = [{option_id, probabilite, confiance, analyse, risques, sources}]
  }

  async function suggestFromCoteur(apiKey, model, ctx, candidates, onProgress) {
    if (!candidates.length) {
      return { analyse_marche: 'Aucun match coteur exploitable dans la fenêtre — élargissez la fenêtre ou les sports.', picks: [], candidats: [] };
    }
    onProgress?.('research', candidates);
    const raw = await callGemini(apiKey, ctx.deepModel || model, coteurPrompt(ctx, candidates), { temperature: 0.25 });
    const parsed = extractJSON(raw);
    if (!parsed || !Array.isArray(parsed.picks)) throw new Error('Réponse du modèle illisible — réessayez.');
    parsed.picks = validatePicks(parsed.picks);
    parsed.candidats = candidates;
    onProgress?.('done');
    return parsed;
  }

  async function suggest(apiKey, model, ctx, onProgress) {
    // Passe 1 : inventaire
    onProgress?.('inventory');
    const raw1 = await callGemini(apiKey, model, pass1Prompt(ctx), { temperature: 0.2 });
    const inv = extractJSON(raw1);
    const candidats = (inv?.candidats || [])
      .filter((c) => c && c.match && /^\d{4}-\d{2}-\d{2}$/.test(c.date || ''))
      .slice(0, 6);

    if (!candidats.length) {
      return { analyse_marche: 'Aucune rencontre majeure vérifiable dans la fenêtre demandée — élargissez la fenêtre ou les sports couverts.', picks: [], candidats: [] };
    }

    // Passe 2 : enquête approfondie
    onProgress?.('research', candidats);
    const raw2 = await callGemini(apiKey, ctx.deepModel || model, pass2Prompt(ctx, candidats), { temperature: 0.25 });
    const parsed = extractJSON(raw2);
    if (!parsed || !Array.isArray(parsed.picks)) throw new Error('Réponse du modèle illisible — réessayez.');

    parsed.picks = validatePicks(parsed.picks);
    parsed.candidats = candidats;
    onProgress?.('done');
    return parsed;
  }

  async function analyzeMatch(apiKey, model, ctx, query) {
    const raw = await callGemini(apiKey, ctx.deepModel || model, matchPrompt(ctx, query), { temperature: 0.25 });
    const parsed = extractJSON(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Réponse du modèle illisible — réessayez.');
    parsed.marches = (parsed.marches || [])
      .filter((m) => m && typeof m.cote === 'number' && typeof m.probabilite === 'number')
      .map((m) => ({ ...m, value_pct: Math.round((m.probabilite * m.cote - 1) * 1000) / 10 }));
    return parsed;
  }

  /* ------------------------------------------------------------------
     Performance et calibration du Radar
     picks[].result : 'won' | 'lost' | 'void' | undefined (ouvert)
     ------------------------------------------------------------------ */
  function radarStats(picks) {
    const settled = picks.filter((p) => p.result === 'won' || p.result === 'lost');
    const n = settled.length;
    if (!n) return null;

    const won = settled.filter((p) => p.result === 'won').length;
    const flatPl = settled.reduce((s, p) => s + (p.result === 'won' ? p.cote - 1 : -1), 0);
    const avgPredicted = settled.reduce((s, p) => s + p.probabilite, 0) / n * 100;
    const actualWinRate = (won / n) * 100;

    // Calibration par tranche de probabilité annoncée
    const buckets = [
      { label: '< 45 %', min: 0, max: 0.45 },
      { label: '45 – 55 %', min: 0.45, max: 0.55 },
      { label: '55 – 65 %', min: 0.55, max: 0.65 },
      { label: '≥ 65 %', min: 0.65, max: 1 }
    ].map((b) => {
      const own = settled.filter((p) => p.probabilite >= b.min && p.probabilite < b.max);
      const w = own.filter((p) => p.result === 'won').length;
      return {
        label: b.label, n: own.length,
        predicted: own.length ? Math.round(own.reduce((s, p) => s + p.probabilite, 0) / own.length * 100) : 0,
        actual: own.length ? Math.round((w / own.length) * 100) : 0
      };
    }).filter((b) => b.n > 0);

    const followed = picks.filter((p) => p.followed && (p.result === 'won' || p.result === 'lost'));
    const followedPl = followed.reduce((s, p) => s + (p.result === 'won' ? p.cote - 1 : -1), 0);

    // CLV (Closing Line Value) : as-tu pris une meilleure cote que la clôture ?
    const withClv = picks.filter((p) => typeof p.clv === 'number');
    const avgClv = withClv.length ? withClv.reduce((s, p) => s + p.clv, 0) / withClv.length : null;
    const posClv = withClv.filter((p) => p.clv > 0).length;

    return {
      settled: n, won,
      hitRate: Math.round(actualWinRate),
      flatRoi: Math.round((flatPl / n) * 1000) / 10,
      avgPredicted: Math.round(avgPredicted),
      actualWinRate: Math.round(actualWinRate),
      calibrationGap: Math.round(avgPredicted - actualWinRate),
      buckets,
      followedCount: followed.length,
      followedRoi: followed.length ? Math.round((followedPl / followed.length) * 1000) / 10 : null,
      openCount: picks.filter((p) => !p.result).length,
      clvCount: withClv.length,
      avgClv: avgClv != null ? Math.round(avgClv * 10) / 10 : null,
      clvPositivePct: withClv.length ? Math.round((posClv / withClv.length) * 100) : null
    };
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

  function stakeFor(bankroll, pick, profileKey, mode = 'kelly') {
    const profile = PROFILES[profileKey] || PROFILES.equilibre;
    const b = pick.cote - 1;
    if (b <= 0 || bankroll <= 0) return { stake: 0, pctBankroll: 0, kelly: 0 };

    const p = pick.probabilite;
    const fullKelly = (pick.cote * p - 1) / b;
    if (fullKelly <= 0) return { stake: 0, pctBankroll: 0, kelly: 0 }; // pas de value → pas de mise

    let fraction;
    if (mode === 'flat') {
      // Mise à plat : fraction fixe = plafond du profil (variance bien plus faible)
      fraction = profile.cap;
      if (pick.cote_verifiee === false) fraction *= 0.5;
    } else {
      // Kelly fractionné plafonné
      fraction = fullKelly * profile.kellyFraction;
      if (pick.cote_verifiee === false) fraction *= 0.5;
      fraction = Math.min(fraction, profile.cap);
    }

    const stake = Math.max(0, Math.floor(bankroll * fraction * 2) / 2);
    return {
      stake,
      pctBankroll: Math.round(fraction * 1000) / 10,
      kelly: Math.round(fullKelly * 1000) / 10
    };
  }

  return { suggest, suggestFromCoteur, suggestFromCoteurMarkets, analyzeMatch, stakeFor, radarStats, feedbackBlock, PROFILES };
})();
