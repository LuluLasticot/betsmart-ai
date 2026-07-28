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
  // Gemini 2.5 Pro est très limité en free tier (≈ 5 requêtes/min, ~50/jour) :
  // en cas de 429 on bascule automatiquement sur Flash plutôt que d'échouer.
  const FALLBACK_MODEL = 'gemini-2.5-flash';
  let onFallback = null; // hook UI (app.js) pour prévenir l'utilisateur
  let onWait = null;     // hook UI : attente volontaire pour respecter le quota

  async function callGemini(apiKey, model, prompt, { temperature = 0.25, retries = 1, allowFallback = true, noTuning = false } = {}) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature,
        // Réflexion minimale + réponse plafonnée : les jetons de « thinking »
        // sont facturés en sortie et représentaient l'essentiel du coût.
        ...(!noTuning && typeof Gemini !== 'undefined' && Gemini.tuning ? Gemini.tuning(model, { maxOutputTokens: 6144 }) : {})
      }
    };
    const Q = (typeof Gemini !== 'undefined' && Gemini.quota) ? Gemini.quota : null;

    for (let attempt = 0; ; attempt++) {
      // On attend un créneau libre AVANT d'appeler : un 429 évité est un quota économisé.
      if (Q) {
        await Q.waitForSlot({ onWait: (s) => onWait?.(s) });
        Q.recordCall();
      }
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

      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `Erreur API (${res.status})`;

      // Quota JOURNALIER épuisé : réessayer ne ferait qu'échouer → on s'arrête net.
      if (res.status === 429 && Q && Q.isDailyQuota(err)) {
        const u = Q.usage();
        throw new Error(`Quota Gemini journalier épuisé (~${u.rpd} requêtes/jour en free tier, ${u.day} utilisées aujourd'hui). Il se réinitialise chaque jour ; sinon activez la facturation sur votre projet Google pour lever la limite.`);
      }

      // 429/503 transitoires : on respecte le délai conseillé par l'API (RetryInfo)
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        const wait = (Q && Q.retryDelayOf(err)) || 20000;
        onWait?.(Math.ceil(wait / 1000));
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      // Réglage de réflexion non supporté par ce modèle → on rejoue sans
      if (res.status === 400 && !noTuning && /thinking|thought/i.test(msg)) {
        return callGemini(apiKey, model, prompt, { temperature, retries: 0, allowFallback, noTuning: true });
      }

      // Modèle retiré par Google → redécouverte automatique et nouvelle tentative
      if (allowFallback && typeof Gemini !== 'undefined' && Gemini.isModelGone(msg)) {
        try {
          const m = await Gemini.resolveModels(apiKey, { force: true });
          const next = /pro/i.test(model) ? m.pro : m.flash;
          if (next && next !== model) {
            onFallback?.(model, next, 'gone');
            return callGemini(apiKey, next, prompt, { temperature, retries: 1, allowFallback: false });
          }
        } catch (_) { /* on remonte l'erreur d'origine */ }
      }

      // Quota Pro épuisé → on refait la même demande avec le modèle rapide
      if (res.status === 429 && allowFallback && /pro/i.test(model)) {
        let fast = FALLBACK_MODEL;
        try { if (typeof Gemini !== 'undefined') fast = (await Gemini.resolveModels(apiKey)).flash || fast; } catch (_) {}
        if (fast !== model) {
          onFallback?.(model, fast, 'quota');
          return callGemini(apiKey, fast, prompt, { temperature, retries: 1, allowFallback: false });
        }
      }
      if (res.status === 429) {
        const u = Q ? Q.usage() : null;
        throw new Error(`Quota Gemini atteint (free tier : ~${u ? u.rpm : 5} requêtes/minute et ~${u ? u.rpd : 20}/jour)${u ? ` — ${u.day} utilisées aujourd'hui` : ''}. Patientez une minute et relancez.`);
      }
      throw new Error(msg);
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

    // Pilotage par la CLV (Closing Line Value) : la vraie boussole de l'edge.
    // Battre la clôture est le signe le plus fiable d'un avantage réel, avant même le résultat.
    let clvBlock = '';
    if (stats.clvCount >= 8 && stats.avgClv != null) {
      if (stats.avgClv <= -0.5) {
        clvBlock = `\n- CLV MOYENNE : ${stats.avgClv} % (${stats.clvPositivePct} % de tes picks battent la clôture). C'est NÉGATIF : en moyenne le marché se resserre CONTRE toi après ta prise — signe que tes probabilités sont trop optimistes ou que tu joues trop tard. CONSIGNE : sois nettement plus sélectif, ne propose que des angles où l'information non intégrée par le marché est manifeste, et abstiens-toi au moindre doute.`;
      } else if (stats.avgClv >= 1) {
        clvBlock = `\n- CLV MOYENNE : +${stats.avgClv} % (${stats.clvPositivePct} % de tes picks battent la clôture). C'est POSITIF : tu prends systématiquement de meilleures cotes que la clôture, ton edge est réel. Maintiens exactement cette rigueur et ce niveau d'exigence.`;
      } else {
        clvBlock = `\n- CLV MOYENNE : ${stats.avgClv >= 0 ? '+' : ''}${stats.avgClv} % (${stats.clvPositivePct} % battent la clôture) : à l'équilibre. Vise à améliorer ta CLV en privilégiant les angles où tu détectes l'information avant le marché.`;
      }
    }

    return `
# RETOUR D'EXPÉRIENCE SUR TES PRÉCÉDENTES ANALYSES (à intégrer sérieusement)

Sur tes ${settled.length} derniers picks réglés :
- Probabilité moyenne annoncée : ${stats.avgPredicted} % — taux de réussite réel : ${stats.actualWinRate} %.
${stats.calibrationGap > 5 ? `- Historiquement tu surestimes tes probabilités d'environ ${stats.calibrationGap} points. IMPORTANT : le système applique DÉJÀ automatiquement une correction de calibration (ancrage marché) après ta réponse — ne réduis donc PAS toi-même tes probabilités, sinon la correction est comptée deux fois. Donne ta probabilité honnête et bien argumentée ; reste simplement rigoureux et factuel.` : stats.calibrationGap < -5 ? `- Historiquement tu sous-estimes tes probabilités d'environ ${Math.abs(stats.calibrationGap)} points : tu peux être légèrement plus assertif quand un fait concret le justifie.` : '- Ta calibration est correcte : maintiens cette rigueur.'}
- ROI théorique à mise constante : ${stats.flatRoi} %.${clvBlock}
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
${ctx.matchFacts ? '\n' + ctx.matchFacts + '\n' : ''}
# RÈGLE ABSOLUE — ZÉRO INVENTION
Tu ne dois JAMAIS inventer de fait, de statistique, de cote ni de source. Appuie-toi EN PRIORITÉ sur les DONNÉES RÉELLES fournies ci-dessus (forme, buts, H2H, classement). Complète-les uniquement par Google Search pour ce qu'elles ne couvrent pas (blessures, suspensions, compositions probables, enjeu, météo). Si une information reste introuvable ou incertaine, écris-le explicitement dans "risques" et NE t'en sers PAS pour gonfler une probabilité. Ne cite comme source que des sites réellement consultés (jamais de nom inventé).

# MISSION
L'utilisateur veut une analyse complète de : « ${query} »

1. Identifie précisément la rencontre (les données réelles ci-dessus font foi si présentes ; sinon Google Search). Si introuvable ou ambiguë, dis-le.
2. Enquête complémentaire via Google Search UNIQUEMENT pour ce que les données réelles ne donnent pas : blessures/suspensions/compos probables (< 48 h), enjeu, fatigue/calendrier, météo/surface si sensible.
3. Pour CHAQUE marché principal (1N2 ou vainqueur, double chance si pertinent, over/under principal, handicap principal) : estime la probabilité calibrée À PARTIR DES FAITS, trouve la cote actuelle chez ${ctx.bookmakers} (ne l'invente pas : si tu n'as pas de cote réelle récente, mets "cote_verifiee": false — elle sera revérifiée), calcule value = (probabilite × cote) − 1.
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
Chaque option a : "id", "cote" (meilleur book FR), "proba_marche_pct" (probabilité du marché, dévigorisée — la meilleure estimation objective de départ), "mouvement_pts" (déplacement récent de la ligne : POSITIF = la cote baisse, l'argent rentre sur cette issue = signal fort ; NÉGATIF = la cote monte). Chaque marché a "trj_pct" (taux de retour ; plus il est haut, plus la marge est faible).
${JSON.stringify(candidates, null, 2)}

# MÉTHODE (via Google Search)
1. Pars de "proba_marche_pct" comme référence de départ : le marché a raison la plupart du temps.
2. Enquête < 48 h : blessures, suspensions, compositions probables, forme réelle des 5 derniers matchs, enjeu, calendrier/fatigue, H2H, météo/surface, style, moyennes de buts.
3. Estime TA probabilité réelle de l'issue. La VALUE existe quand ta probabilité est SUPÉRIEURE à proba_marche_pct — c'est-à-dire quand tu as identifié une information ou un angle que le prix n'intègre pas encore (une absence, une dynamique, un déséquilibre stylistique, une sur-réaction du marché…). Value = ta_probabilité × cote − 1.
4. Ta probabilité sera automatiquement mélangée à celle du marché pour rester prudente — n'hésite pas à donner ta vraie estimation quand tu as une conviction fondée.

# SÉLECTION
- Retiens les options où TON analyse justifie une probabilité nettement au-dessus du marché, appuyée sur un fait concret. Un "mouvement_pts" positif qui va dans ton sens (la ligne bouge déjà en ta faveur) renforce fortement le pick.
- Préfère les marchés à "trj_pct" élevé (faible marge). Cotes 1,40–5,00. Confiance 1-5 (< 3 = écarter). Jusqu'à 5 picks, un par match, classés du plus prometteur au moins.
- Vise 3 à 5 picks si le plateau le permet ; l'abstention totale ("picks": []) est réservée aux cas où aucun match n'offre le moindre angle exploitable.

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

  /* ------------------------------------------------------------------
     Calendrier via recherche (sans cotes) — pour les sports peu/pas couverts
     par coteur (badminton, etc.). Gemini + Google Search liste les vraies
     rencontres à venir ; chacune devient cliquable « Analyser ».
     ------------------------------------------------------------------ */
  function fixturesPrompt(ctx) {
    return `Tu es un assistant de recherche sportive. Date/heure actuelles : ${ctx.now} (Europe/Paris).
Via Google Search, dresse la liste des rencontres de ${ctx.sport} RÉELLEMENT programmées (à venir ou tout juste commencées) dans les ${ctx.horizon} prochaines heures. Couvre les tournois/compétitions professionnels pertinents.
Pour chaque match : les deux joueurs/équipes, la compétition/tournoi, la date et l'heure locale (Europe/Paris) si connues.
N'INVENTE AUCUN match : chaque entrée doit provenir de ta recherche. En cas de doute, ne l'inclus pas.

Termine par un unique bloc \`\`\`json :
\`\`\`json
{"matches":[{"competition":"...","match":"Joueur A – Joueur B","date":"YYYY-MM-DD","heure":"HH:MM"}]}
\`\`\`
Maximum 40 matchs, triés par heure croissante. Si aucun match fiable, renvoie {"matches":[]}.`;
  }

  async function listFixtures(apiKey, model, ctx) {
    const raw = await callGemini(apiKey, model, fixturesPrompt(ctx), { temperature: 0.15 });
    const parsed = extractJSON(raw);
    return (parsed && Array.isArray(parsed.matches) ? parsed.matches : [])
      .filter((m) => m && typeof m.match === 'string' && /[–—-]|vs/i.test(m.match))
      .slice(0, 40);
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

  /** Arrondi de mise adapté à l'ordre de grandeur : 0,50 € sur une bankroll en euros,
      mais plusieurs décimales sur une bankroll en crypto (0,048 SOL…), sinon toute
      mise recommandée serait arrondie à zéro. */
  function roundStake(v) {
    if (!(v > 0)) return 0;
    if (v >= 20) return Math.floor(v * 2) / 2;       // au demi près
    if (v >= 2) return Math.floor(v * 10) / 10;      // au dixième
    if (v >= 0.1) return Math.floor(v * 100) / 100;  // au centième
    const d = Math.min(8, Math.max(3, 3 - Math.floor(Math.log10(v)))); // ~3 chiffres significatifs
    const f = Math.pow(10, d);
    return Math.floor(v * f) / f;
  }

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

    const stake = roundStake(bankroll * fraction);
    return {
      stake,
      pctBankroll: Math.round(fraction * 1000) / 10,
      kelly: Math.round(fullKelly * 1000) / 10
    };
  }

  const setFallbackHandler = (fn) => { onFallback = fn; };
  const setWaitHandler = (fn) => { onWait = fn; };

  return { suggest, suggestFromCoteur, suggestFromCoteurMarkets, analyzeMatch, listFixtures, stakeFor, radarStats, feedbackBlock, setFallbackHandler, setWaitHandler, PROFILES };
})();
