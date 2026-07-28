/* ==========================================================================
   BetSmart AI — Règlement automatique des paris
   Gemini + Google Search vérifie les résultats des paris en attente dont
   le match est passé, et propose gagné/perdu/annulé. L'utilisateur confirme
   toujours avant écriture : l'IA propose, l'humain décide.
   ========================================================================== */
'use strict';

const Settle = (() => {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

  function buildPrompt(bets, now) {
    const list = bets.map((b) => ({
      id: b.id,
      sport: b.sport,
      competition: b.competition || null,
      match: b.event,
      date: b.date,
      pari: b.selection,
      type: b.betType,
      cote: b.odds
    }));

    return `Tu es un vérificateur de résultats sportifs rigoureux. Date et heure actuelles : ${now} (Europe/Paris).

Voici des paris en attente de règlement :
${JSON.stringify(list, null, 2)}

Pour CHAQUE pari, recherche sur Google le résultat officiel du match, puis détermine si le pari précis ("pari") est gagné ou perdu.

Règles strictes :
- Vérifie le SCORE FINAL officiel (source fiable : site de la ligue, flashscore, l'équipe, etc.). Attention aux prolongations : pour le football, un pari 1N2 se règle au temps réglementaire ; pour le basket/tennis, au résultat final.
- Évalue le pari exact : "Plus de 2,5 buts" avec un score 2-1 → gagné (3 buts). "Victoire X" avec nul → perdu.
- Pour un combiné, TOUTES les sélections doivent être gagnantes ; si une seule est perdante → perdu ; si tu ne peux pas vérifier chaque sélection → "unknown".
- Match reporté ou annulé → "void".
- Match pas encore joué ou pas terminé → "not_played".
- Si tu ne trouves pas de résultat fiable et concordant → "unknown". NE DEVINE JAMAIS.

Termine ta réponse par un unique bloc \`\`\`json :
\`\`\`json
[
  {
    "id": "identifiant du pari",
    "statut": "won" | "lost" | "void" | "not_played" | "unknown",
    "score": "score final trouvé (ex: '2-1') ou null",
    "explication": "1 phrase : le résultat et pourquoi le pari est gagné/perdu",
    "source": "site où tu as vérifié",
    "confiance": 0.95
  }
]
\`\`\``;
  }

  async function check(apiKey, model, pendingBets) {
    const now = new Date().toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
    const body = {
      contents: [{ role: 'user', parts: [{ text: buildPrompt(pendingBets, now) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0 }
    };

    // Comptabilise l'appel dans le quota partagé (et attend un créneau si besoin)
    if (typeof Gemini !== 'undefined' && Gemini.quota) {
      await Gemini.quota.waitForSlot();
      Gemini.quota.recordCall();
    }

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
    const parsed = extractJSON(text);
    if (!Array.isArray(parsed)) throw new Error('Réponse du modèle illisible — réessayez.');

    // Filet de sécurité : seuls les ids réellement en attente sont retenus
    const validIds = new Set(pendingBets.map((b) => b.id));
    return parsed.filter((r) => validIds.has(r.id) && ['won', 'lost', 'void', 'not_played', 'unknown'].includes(r.statut));
  }

  function extractJSON(text) {
    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    const candidates = [];
    if (fenced) candidates.push(fenced[1]);
    const first = text.indexOf('[');
    const last = text.lastIndexOf(']');
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
    for (const c of candidates) {
      try { return JSON.parse(c); } catch (_) { /* essai suivant */ }
    }
    return null;
  }

  return { check };
})();
