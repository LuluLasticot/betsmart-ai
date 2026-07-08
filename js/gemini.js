/* ==========================================================================
   BetSmart AI — Intégration Google Gemini
   1. Smart Scan : capture de ticket → JSON structuré (Vision)
   2. Coach IA  : résumé statistique → insights en langage naturel
   ========================================================================== */
'use strict';

const Gemini = (() => {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

  async function call(apiKey, model, parts, jsonSchema) {
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    };
    if (jsonSchema) body.generationConfig.responseSchema = jsonSchema;

    const res = await fetch(`${BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `Erreur API (${res.status})`;
      throw new Error(msg);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text) throw new Error('Réponse vide du modèle.');
    return JSON.parse(text);
  }

  /* ------------------------------------------------------------------
     Smart Scan — extraction d'un ticket de pari depuis une image
     ------------------------------------------------------------------ */
  const SCAN_PROMPT = `Tu es un extracteur de données spécialisé dans les tickets de paris sportifs français (Winamax, Betclic, Unibet, ParionsSport, PMU, Zebet, Bwin…).
Analyse la capture d'écran fournie et retourne UNIQUEMENT un objet JSON avec ces champs :

{
  "bookmaker": "nom du bookmaker visible ou déduit du design, sinon null",
  "sport": "sport concerné (Football, Tennis, Basketball…), sinon null",
  "competition": "compétition/championnat, sinon null",
  "event": "le match ou l'événement (ex: 'PSG – OM'), sinon null",
  "selection": "le pari joué (ex: 'Victoire PSG', 'Plus de 2,5 buts', ou la liste des sélections d'un combiné), sinon null",
  "betType": "simple" | "combine" | "systeme",
  "legs": nombre de sélections si combiné/système, sinon 1,
  "odds": cote totale en nombre décimal (ex: 1.85), sinon null,
  "stake": mise en euros en nombre décimal, sinon null,
  "date": "date du pari au format YYYY-MM-DD si visible, sinon null",
  "status": "pending" | "won" | "lost" (déduis du ticket : 'Gagné', coche verte → won ; 'Perdu' → lost ; sinon pending),
  "confidence": nombre entre 0 et 1 estimant ta confiance globale
}

Règles :
- Les cotes françaises utilisent la virgule (1,85) : convertis en point (1.85).
- Si plusieurs sélections sont listées, c'est un combiné : "betType": "combine" et "odds" = cote totale du combiné.
- Ne devine jamais une mise ou une cote absente : mets null.
- Réponds uniquement avec le JSON, sans texte autour.`;

  async function scanTicket(apiKey, model, base64Data, mimeType) {
    const parts = [
      { text: SCAN_PROMPT },
      { inlineData: { mimeType, data: base64Data } }
    ];
    return call(apiKey, model, parts);
  }

  /* ------------------------------------------------------------------
     Coach IA — insights comportementaux
     ------------------------------------------------------------------ */
  const COACH_SCHEMA = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        type: { type: 'STRING', enum: ['alerte', 'conseil', 'positif'] },
        titre: { type: 'STRING' },
        message: { type: 'STRING' }
      },
      required: ['type', 'titre', 'message']
    }
  };

  function coachPrompt(summary) {
    return `Tu es un coach expert en gestion de bankroll de paris sportifs. Tu analyses les statistiques d'un parieur et tu détectes ses biais et erreurs de stratégie.

Voici son résumé statistique (montants en euros) :
${JSON.stringify(summary, null, 2)}

Génère entre 3 et 5 insights en français, concrets et chiffrés, classés du plus important au moins important. Types :
- "alerte" : comportement qui détruit sa rentabilité (ROI très négatif sur un segment, combinés longs perdants, mises trop grosses vs bankroll…)
- "conseil" : optimisation possible (réallouer les mises vers les segments rentables, réduire la variance…)
- "positif" : point fort à conserver (segment très rentable, discipline de mise…)

Règles :
- Chaque message cite des chiffres précis issus des données (ROI, profits, nombre de paris).
- Ignore les segments avec moins de 3 paris (échantillon trop faible), ou signale que l'échantillon est trop petit.
- Sois direct et actionnable, comme un coach exigeant mais bienveillant. Pas de généralités creuses.
- Si l'échantillon global est inférieur à 10 paris réglés, précise que les conclusions restent provisoires.
- Titres courts (max 8 mots).`;
  }

  async function coach(apiKey, model, summary) {
    return call(apiKey, model, [{ text: coachPrompt(summary) }], COACH_SCHEMA);
  }

  /* ------------------------------------------------------------------
     Bilan de performance personnalisé
     ------------------------------------------------------------------ */
  const REVIEW_SCHEMA = {
    type: 'OBJECT',
    properties: {
      resume: { type: 'STRING' },
      forces: { type: 'ARRAY', items: { type: 'OBJECT', properties: { titre: { type: 'STRING' }, detail: { type: 'STRING' } }, required: ['titre', 'detail'] } },
      faiblesses: { type: 'ARRAY', items: { type: 'OBJECT', properties: { titre: { type: 'STRING' }, detail: { type: 'STRING' } }, required: ['titre', 'detail'] } },
      recommandations: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['resume', 'forces', 'faiblesses', 'recommandations']
  };

  function reviewPrompt(summary) {
    return `Tu es un coach expert en gestion de bankroll de paris sportifs. Analyse en profondeur ce bilan statistique d'un parieur (montants en euros) :
${JSON.stringify(summary, null, 2)}

Produis un bilan personnalisé, chiffré et actionnable, en français :
- "resume" : 2-3 phrases sur l'état de santé global du parieur (rentabilité, discipline, points saillants).
- "forces" : 2-4 zones réellement rentables (sport, compétition, tranche de cote, type, tipster…), chacune avec des chiffres précis. Ignore les segments < 5 paris.
- "faiblesses" : 2-4 zones qui détruisent la rentabilité, chiffrées (ROI négatif, combinés, tilt, mauvaise calibration…).
- "recommandations" : 3-5 actions concrètes et priorisées (réallouer les mises, arrêter tel segment, stabiliser la mise…).
Sois direct et exigeant mais bienveillant. Pas de généralités : chaque point s'appuie sur les données.`;
  }

  async function review(apiKey, model, summary) {
    return call(apiKey, model, [{ text: reviewPrompt(summary) }], REVIEW_SCHEMA);
  }

  /* ------------------------------------------------------------------
     Test de connexion
     ------------------------------------------------------------------ */
  async function test(apiKey, model) {
    const out = await call(apiKey, model, [{ text: 'Réponds uniquement avec le JSON {"ok": true}' }]);
    return out && out.ok === true;
  }

  /* ------------------------------------------------------------------
     Utilitaire : File/Blob → base64 (sans préfixe data:)
     ------------------------------------------------------------------ */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
      reader.readAsDataURL(file);
    });
  }

  return { scanTicket, coach, review, test, fileToBase64 };
})();
