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
4. Verdict global : le meilleur angle si tu en vois un, ou "à éviter" si aucun marché ne t'inspire confiance.
   N'applique AUCUN seuil chiffré de value : ce n'est pas ton rôle. Le système compare ensuite tes probabilités aux prix réellement disponibles, au modèle quantitatif et à l'historique mesuré — trois éléments dont tu ne disposes pas. Ton travail s'arrête à une probabilité honnête et à la qualité de ton information.

Termine par un unique bloc \`\`\`json :
\`\`\`json
{
  "match": "…", "sport": "…", "competition": "…", "date_match": "YYYY-MM-DD", "heure_match": "HH:MM",
  "trouve": true,
  "verdict": "a_jouer" | "a_eviter",
  "resume": "3-4 phrases : lecture globale du match, information clé.",
  "marches": [
    {"marche": "1N2", "selection": "…", "cote": 1.85, "cote_verifiee": true, "bookmaker": "…", "cote_marche": 1.80, "probabilite": 0.55, "value_pct": 1.8, "jouable": false, "avis": "1 phrase"}
  ],
  "meilleur_marche": "libellé du marché retenu ou null",
  "risques": "1-2 phrases.",
  "sources": ["site — ce qui a été vérifié"]
}
\`\`\`
Ne force JAMAIS un verdict "a_jouer" : la plupart des matchs ne présentent aucune value exploitable.

# PRIX DE MARCHÉ — "cote_marche"
Pour chaque marché, indique en plus la cote CONSENSUS que tu observes chez la majorité des books (pas la meilleure, la plus courante). Si tu ne la trouves pas de source récente, mets null plutôt que d'estimer.
Cette valeur ne sert PAS à calculer la value : le système la compare au prix réellement disponible pour repérer un book en retard sur le marché. Un écart net entre les deux est l'information la plus exploitable qui existe, bien davantage qu'une prédiction.

# COHÉRENCE — RÈGLE IMPÉRATIVE
"jouable" doit refléter ta VRAIE conclusion sur ce marché. Sa seule fonction est d'empêcher une contradiction entre ton texte et le chiffre : ne mets JAMAIS "jouable": true sur un marché dont tu écris dans "avis" qu'il n'offre aucune marge, et inversement ne mets pas "jouable": false sur un marché que tu décris comme intéressant.
Mets "jouable": false UNIQUEMENT pour une raison d'INFORMATION : composition inconnue, partant non annoncé, blessure non confirmée, sources qui se contredisent, échantillon inexploitable.
Ne le mets JAMAIS pour une raison de PRIX ou de marge : « la value est faible », « le marché est efficient », « en dessous de 5 % », « pas assez de marge de sécurité » ne sont pas des motifs valables — ce sont des jugements que le système fait après toi, avec le prix réellement disponible que tu ne connais pas forcément. Un marché sur lequel tu as des faits solides et une probabilité assumée doit avoir "jouable": true, même si l'avantage te paraît mince.`;
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

Tu es un analyste quantitatif senior. Ton unique travail ici : estimer des PROBABILITÉS RÉELLES calibrées, à partir de faits vérifiés.

# PROTOCOLE EN DEUX PHASES — TU ES EN PHASE A
Tu travailles À L'AVEUGLE : aucune cote ne t'est communiquée, volontairement. Tu ne dois ni les deviner, ni les chercher, ni raisonner en termes de « value ». La comparaison aux cotes (phase B) est faite par le système APRÈS ta réponse, et ton estimation ne sera jamais réajustée aux prix. Une estimation influencée par les cotes est une estimation corrompue.
${ctx.feedback}

# MATCHS ET ISSUES À ÉVALUER
Chaque option a un "id" et un libellé d'issue. Évalue les issues qui te semblent analysables.
Quand un match porte un champ "donnees_verifiees", ce sont des MESURES RÉELLES issues de bases de référence (Elo, efficacité, niveau d'équipe), déjà vérifiées : traite-les comme acquises, ne les recontrôle pas, et ne les contredis qu'avec un fait récent et précis (blessure officielle, forfait, changement d'effectif).
${JSON.stringify(candidates, null, 2)}

# GRILLE D'ANALYSE PROPRE AU SPORT — applique celle du match traité
- FOOTBALL : buts attendus (xG) créés et concédés sur les 6 derniers matchs, pas les buts réels ; qualité de l'adversité ; blessures et suspensions des titulaires du onze type ; rotation en cas de match européen à J−3 ; enjeu réel (maintien acquis, priorité coupe). Le nul est structurellement sous-estimé par l'intuition : ~26 % des matchs des grands championnats.
- TENNIS : l'Elo par surface prime sur le classement ATP/WTA. % de points gagnés derrière la 1re et la 2e balle, % de balles de break sauvées et converties, sur les 12 derniers mois et sur CETTE surface. Confrontation stylistique (gros serveur contre relanceur) croisée avec la vitesse du court. Fatigue : durée des matchs précédents du tournoi, transition de surface récente. Écarte Challenger, ITF et qualifications, y compris dans les tête-à-tête.
- BASKET : efficacité offensive et défensive pour 100 possessions plutôt que les points par match, qui dépendent du rythme. Absences déclarées au rapport de blessures officiel — l'absence d'un joueur majeur vaut plusieurs points de marge. Back-to-back et déplacement long. Le rythme (possessions par match) détermine les totaux, pas le vainqueur.
- BASEBALL : le LANCEUR PARTANT annoncé domine tout le reste — son FIP, ses manches lancées, son historique récent. Sans partant confirmé pour les deux camps, abstiens-toi. Ensuite : état du bullpen (manches lancées les 3 derniers jours), effets du stade (dimensions, altitude), vent et température, avantage gaucher/droitier. Le baseball est le sport le plus aléatoire de la sélection : même la meilleure équipe perd 4 matchs sur 10, donc les probabilités extrêmes y sont presque toujours fausses.

# SOURCES (hiérarchie stricte)
Officiels (fédérations, ligues, sites de club) > bases statistiques reconnues (Tennis Abstract, FBref, Statcast, Opta) > médias spécialisés reconnus. JAMAIS de tipsters, blogs de pronostics, forums ou réseaux sociaux comme source de validation.

# QUALITÉ DES DONNÉES
- Protocole « 4 yeux » : toute statistique déterminante doit être confirmée par DEUX sources indépendantes. Sinon, considère-la comme non établie.
- Cherche ACTIVEMENT les données qui CONTREDISENT ton hypothèse ; si elles sont solides, abandonne l'angle.
- Écarte les niveaux qui gonflent artificiellement les bilans : tennis → uniquement ATP 250+ / WTA Tour (pas de Challenger, ITF ni qualifications, y compris dans les tête-à-tête et les bilans de surface) ; football → écarte les amicaux et les équipes réserves.
- Fenêtre temporelle : 5 ans glissants (2021 et après) pour le structurel (tête-à-tête, affinité au tournoi, bilan de surface) ; 12 derniers mois pour la forme et le niveau actuel. Rien avant 2021.
- Sources à privilégier par sport — tennis : Tennis Abstract (stats détaillées par surface : % d'aces, % de 1re balle, balles de break, ratio de domination) et un service de résultats/H2H en direct reconnu ; football : FBref/Understat (xG) et le site officiel de la compétition ; baseball : MLB.com / Statcast.

# FACTEURS À ANALYSER
Forme récente vérifiée match par match (et NIVEAU des adversaires rencontrés, pas seulement les résultats) ; bilan sur la surface/terrain exact ; tête-à-tête au même niveau de compétition ; fatigue et calendrier (matchs récents, déplacements, prolongations) ; transition de surface ; style de jeu et confrontation stylistique ; blessures et absences OFFICIELLES ; avantage du terrain ; affinité au tournoi (vainqueurs ET finalistes des 3 dernières éditions, profil de joueur qui y réussit, résultats personnels du joueur sur cet événement) ; conditions de jeu — VITESSE DU COURT (indice de rapidité de la surface par rapport à la moyenne du circuit : un court rapide favorise les gros serveurs et les jeux courts, un court lent les relanceurs et l'usure ; cite l'indice s'il est documenté, sinon décris qualitativement sans l'inventer), indoor/outdoor, altitude (balles plus rapides), météo, type de balle.

# ESTIMATION — FOURCHETTE OBLIGATOIRE
Pour chaque issue retenue, donne TROIS probabilités : "proba_basse" (borne prudente), "proba_mediane" (ton estimation centrale), "proba_haute" (borne optimiste). La fourchette doit refléter honnêtement ton incertitude : plus l'information est faible ou contradictoire, plus elle est large. Le système calculera l'edge sur la BORNE BASSE : une conviction mal étayée sera donc automatiquement écartée.

Attribue aussi une qualité de dossier :
- "A" : données complètes, confirmées par 2+ sources, aucun angle mort.
- "B" : bonnes données, une incertitude mineure.
- "C" : données partielles ou non confirmées.
- "D" : trop peu d'information fiable → NE PROPOSE PAS cette issue.

# SÉLECTION
- Le NO BET est une conclusion valide et respectable : mieux vaut 0 pick qu'un pick mal étayé.
- Ne retiens QUE les issues de qualité A ou B, sur lesquelles tu as des faits concrets et vérifiés.
- Un seul pick par match, maximum 5, classés du dossier le plus solide au moins solide.

# CONTEXTE UTILISATEUR
Profil ${ctx.riskProfile} · Performance passée : ${ctx.userPerf}

# DEUXIÈME LIVRABLE — LES PARIS DE CONVICTION (objectif DIFFÉRENT)
En plus des picks ci-dessus, donne pour CHAQUE match analysé le pari sur lequel tu es le PLUS SÛR — celui que tu jouerais si on te demandait « quel est le résultat le plus probable ici ? ».

Ne confonds pas les deux exercices :
- Les "picks" cherchent une issue que le marché sous-estime.
- Les "convictions" cherchent l'issue la PLUS PROBABLE, que le marché la connaisse ou non. Un favori évident est une conviction parfaitement valable.

Règles propres aux convictions :
- Tu n'es PAS limité aux issues listées : tu peux proposer n'importe quel marché courant (double chance, draw no bet, over/under, les deux marquent, handicap, buteur, nombre de sets ou de jeux au tennis, total de points…). Si tu choisis une issue de la liste, indique son "option_id" ; sinon mets "option_id": null et décris le marché dans "marche" et "selection".
- Vise une probabilité RÉALISTE et calibrée : ne dis pas 95 % pour te rassurer. Une conviction honnête à 68 % vaut mieux qu'une conviction gonflée à 90 %.
- Qualité "A" ou "B" exigée. Un seul pari de conviction par match, le plus solide.
- Ne mentionne toujours AUCUNE cote : tu ne les connais pas et le système s'en charge.

# SORTIE — termine par un unique bloc \`\`\`json :
\`\`\`json
{
  "analyse_marche": "2-3 phrases sur le plateau du jour (sans parler de cotes).",
  "picks": [
    {"option_id":"1n2_1","proba_basse":0.52,"proba_mediane":0.58,"proba_haute":0.64,"qualite":"A","confiance":4,"verdict":"jouer",
     "analyse":"3-5 phrases FACTUELLES, chiffrées, issues de ta recherche.","risques":"1-2 phrases : ce qui invaliderait l'analyse.",
     "sources":["source 1 — ce qui a été vérifié","source 2 — confirmation indépendante"]}
  ],
  "convictions": [
    {"match":"Équipe A – Équipe B","option_id":"1n2_1","marche":"Résultat (1N2)","selection":"Victoire Équipe A",
     "proba_basse":0.60,"proba_mediane":0.68,"proba_haute":0.74,"qualite":"A","confiance":4,
     "analyse":"2-4 phrases factuelles : pourquoi cette issue est la plus probable.","risques":"1 phrase."}
  ]
}
\`\`\`
"option_id" DOIT être l'un des id fournis. Deux sources minimum par pick. Ne mentionne aucune cote.

"verdict" vaut "jouer" ou "passer" et exprime ta conviction RÉELLE. Son seul rôle est d'éviter que tu recommandes un pari que ton propre texte déconseille — pas de te faire refuser par principe.
Mets "passer" uniquement dans ces cas précis : ta fourchette de probabilité est si large que tu ne sais pas trancher ; les faits que tu as trouvés se contredisent ; ou une information déterminante te manque (composition, partant, forfait non confirmé).
Mets "jouer" dès que ton dossier tient debout, MÊME si l'avantage te paraît modeste et MÊME si le marché connaît les mêmes faits que toi : ce n'est pas à toi d'arbitrer si l'écart est suffisant, le système le fait ensuite avec le modèle quantitatif et l'historique de performance. Refuser systématiquement n'est pas de la rigueur : sans picks, rien ne peut être mesuré ni amélioré.`;
  }

  async function suggestFromCoteurMarkets(apiKey, model, ctx, candidates, onProgress) {
    if (!candidates.length) {
      return { analyse_marche: 'Aucun match coteur exploitable dans la fenêtre — élargissez la fenêtre ou les sports.', picks: [], raw: true };
    }
    onProgress?.('research', candidates);
    const raw = await callGemini(apiKey, ctx.deepModel || model, marketsPrompt(ctx, candidates), { temperature: 0.25 });
    const parsed = extractJSON(raw);
    if (!parsed || !Array.isArray(parsed.picks)) throw new Error('Réponse du modèle illisible — réessayez.');
    if (!Array.isArray(parsed.convictions)) parsed.convictions = []; // mode Conviction optionnel
    onProgress?.('done');
    return parsed; // picks = value ; convictions = pari le plus probable par match
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
     Auto-élagage par CLV
     --------------------------------------------------------------------
     La CLV (cote prise / cote de clôture − 1) est le seul indicateur de
     qualité disponible AVANT de connaître les résultats, et il est bien
     moins bruité que le ROI : un pari sur deux est perdant par nature, mais
     une CLV négative répétée signifie qu'on paie systématiquement trop cher.

     Principe : ventiler les picks par segment (sport, type de marché,
     tranche de cote, délai avant le coup d'envoi), puis désactiver les
     segments dont la CLV moyenne est négative DE FAÇON STATISTIQUEMENT
     LISIBLE. La condition de significativité est essentielle : sur 8 paris,
     une CLV de −3 % ne veut rien dire.
     ------------------------------------------------------------------ */

  /** Tranche de cote — la marge des books et le biais favori-outsider
      varient énormément d'une tranche à l'autre. */
  function oddsBand(cote) {
    const c = Number(cote);
    if (!(c > 1)) return null;
    if (c < 1.5) return 'cote < 1,50';
    if (c < 2) return 'cote 1,50–2,00';
    if (c < 3) return 'cote 2,00–3,00';
    return 'cote ≥ 3,00';
  }

  /** Délai entre la prise de position et le coup d'envoi. Les lignes ouvrent
      molles et se resserrent : le moment où l'on parie pèse souvent plus que
      le choix du pari lui-même. */
  function leadBand(pick) {
    const ko = Number(pick.kickoff), at = Number(pick.createdAt || pick.at);
    if (!(ko > 0) || !(at > 0)) return null;
    const h = (ko - at) / 3600e3;
    if (h < 0) return null;
    if (h < 2) return 'pris < 2 h avant';
    if (h < 12) return 'pris 2–12 h avant';
    if (h < 36) return 'pris 12–36 h avant';
    return 'pris > 36 h avant';
  }

  /** Famille de marché (1N2, over/under, handicap…). */
  function marketFamily(marche) {
    const m = String(marche || '').toLowerCase();
    if (/1n2|moneyline|vainqueur|winner/.test(m)) return 'vainqueur';
    if (/over|under|total|plus de|moins de/.test(m)) return 'total';
    if (/handicap|spread|run line|écart/.test(m)) return 'handicap';
    if (/double chance/.test(m)) return 'double chance';
    return m ? 'autre' : null;
  }

  function segmentsOf(pick) {
    const out = [];
    if (pick.sport) out.push(['sport', String(pick.sport)]);
    const fam = marketFamily(pick.marche);
    if (fam) out.push(['marché', fam]);
    const band = oddsBand(pick.cote);
    if (band) out.push(['cote', band]);
    const lead = leadBand(pick);
    if (lead) out.push(['timing', lead]);
    return out;
  }

  /**
   * Bilan de CLV par segment.
   * @returns [{ dim, key, n, avgClv, se, ci95, verdict }] trié du pire au meilleur.
   *   verdict : 'exclu' (négatif et significatif) | 'surveille' | 'ok'
   */
  function statsOf(vals) {
    const n = vals.length;
    if (!n) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const varr = n > 1 ? vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0;
    const se = n > 1 ? Math.sqrt(varr / n) : null;
    return { n, mean, ci95: se != null ? 1.96 * se : null };
  }

  function tally(picks) {
    const map = new Map();
    for (const p of picks) {
      for (const [dim, key] of segmentsOf(p)) {
        const id = dim + '|' + key;
        if (!map.has(id)) map.set(id, { dim, key, vals: [] });
        map.get(id).vals.push(p.clv);
      }
    }
    return map;
  }

  /**
   * Exclusion GLOUTONNE et itérative. Les segments se recoupent : un pick de
   * baseball appartient aussi à une tranche de cote et à une tranche de délai.
   * Une évaluation en un seul passage exclut donc des segments sains, simplement
   * contaminés par les picks du segment réellement fautif. On retire donc le pire
   * segment, on en écarte les picks, et on réévalue — jusqu'à ce que plus rien
   * ne soit exclu. Un segment sain le reste, une fois le coupable isolé.
   *
   * @param minN     nombre minimum de picks pour qu'un segment soit jugeable
   * @param material CLV en dessous de laquelle la perte est jugée matérielle (%)
   */
  function clvSegments(picks, { minN = 12, material = -1 } = {}) {
    let live = (picks || []).filter((p) => typeof p.clv === 'number' && isFinite(p.clv));
    const excluded = new Map();

    for (let pass = 0; pass < 6; pass++) {
      let worst = null;
      for (const { dim, key, vals } of tally(live).values()) {
        const st = statsOf(vals);
        if (!st || st.n < minN || st.ci95 == null) continue;
        // Deux conditions cumulatives : la perte doit être MATÉRIELLE (au-delà
        // du simple bruit de mesure) et STATISTIQUEMENT établie (l'intervalle
        // de confiance à 95 % reste entièrement sous zéro).
        if (st.mean >= material || (st.mean + st.ci95) >= 0) continue;
        if (!worst || st.mean < worst.st.mean) worst = { dim, key, st };
      }
      if (!worst) break;
      const id = worst.dim + '|' + worst.key;
      excluded.set(id, { dim: worst.dim, key: worst.key, n: worst.st.n, mean: worst.st.mean, ci95: worst.st.ci95 });
      live = live.filter((p) => !segmentsOf(p).some(([d, k]) => d === worst.dim && k === worst.key));
    }

    // Bilan final : chaque segment est réévalué sur l'échantillon restant,
    // sauf ceux déjà exclus, qui conservent leurs chiffres du moment de l'exclusion.
    const rows = [];
    for (const e of excluded.values()) {
      rows.push({ dim: e.dim, key: e.key, n: e.n,
        avgClv: Math.round(e.mean * 100) / 100,
        ci95: e.ci95 != null ? Math.round(e.ci95 * 100) / 100 : null,
        verdict: 'exclu' });
    }
    for (const { dim, key, vals } of tally(live).values()) {
      const st = statsOf(vals);
      if (!st) continue;
      rows.push({ dim, key, n: st.n,
        avgClv: Math.round(st.mean * 100) / 100,
        ci95: st.ci95 != null ? Math.round(st.ci95 * 100) / 100 : null,
        verdict: (st.mean < material && st.n >= minN) ? 'surveille' : 'ok' });
    }
    return rows.sort((a, b) => a.avgClv - b.avgClv);
  }

  /** Ensemble des segments à exclure, sous forme consultable rapidement. */
  function clvBlocklist(picks, opts) {
    const set = new Set();
    for (const r of clvSegments(picks, opts)) if (r.verdict === 'exclu') set.add(r.dim + '|' + r.key);
    return set;
  }

  /** Un pick candidat tombe-t-il dans un segment exclu ? Renvoie la raison ou null. */
  function clvBlocked(blocklist, candidate) {
    if (!blocklist || !blocklist.size) return null;
    for (const [dim, key] of segmentsOf(candidate)) {
      if (blocklist.has(dim + '|' + key)) return `${dim} « ${key} » : CLV durablement négative sur votre historique`;
    }
    return null;
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

  /* ------------------------------------------------------------------
     MODE CONVICTION — staking à plat
     Ici on ne cherche PAS de value : l'espérance reste négative de la marge
     du book. Kelly est donc inapplicable (il recommanderait zéro). On mise
     une fraction FIXE et basse de la bankroll, modulée par trois paliers de
     conviction. Simple, honnête, et à variance maîtrisée.
     ------------------------------------------------------------------ */
  const CONVICTION_TIERS = { elevee: 1.5, bonne: 1.0, moderee: 0.6 };

  function convictionStake(bankroll, pick, { pct = 0.5 } = {}) {
    if (!(bankroll > 0)) return { stake: 0, pctBankroll: 0 };
    const base = (Number(pct) || 0.5) / 100;
    let fraction = base * (CONVICTION_TIERS[pick.conviction] || 1);
    if (pick.cote_verifiee === false) fraction *= 0.5; // cote saisie à la main
    return {
      stake: roundStake(bankroll * fraction),
      pctBankroll: Math.round(fraction * 1000) / 10
    };
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

  return { suggest, suggestFromCoteur, suggestFromCoteurMarkets, analyzeMatch, listFixtures, stakeFor, radarStats,
    clvSegments, clvBlocklist, clvBlocked, oddsBand, leadBand, marketFamily,
    convictionStake, CONVICTION_TIERS,
    feedbackBlock, setFallbackHandler, setWaitHandler, PROFILES };
})();
