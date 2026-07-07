/* ==========================================================================
   BetSmart AI — Scores en direct
   Coteur n'exposant pas de flux live exploitable, on interroge Gemini +
   Google Search sur les seuls matchs des paris en cours du jour.
   Résultat mis en cache 45 s pour ménager le quota lors des rafraîchissements.
   ========================================================================== */
'use strict';

const Live = (() => {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  let cache = { at: 0, key: '', data: [] };

  function buildPrompt(matches, now) {
    const list = matches.map((m) => ({ id: m.id, match: m.event, sport: m.sport, date: m.date }));
    return `Tu es un fournisseur de scores sportifs en direct. Date et heure actuelles : ${now} (Europe/Paris).

Pour CHACUN de ces matchs, recherche via Google le score actuel et l'état en temps réel :
${JSON.stringify(list, null, 2)}

Règles :
- Donne le score EN COURS s'il est joué maintenant, le score FINAL s'il est terminé.
- "etat" : "a_venir" (pas commencé), "en_cours" (en jeu), "mi_temps", "termine", "inconnu" (introuvable).
- "minute" : minute de jeu si en cours (ex "62'"), "MT" à la mi-temps, "Fin" si terminé, sinon l'heure de coup d'envoi.
- N'invente jamais un score : si tu ne trouves pas, "etat":"inconnu".

Termine par un unique bloc \`\`\`json :
\`\`\`json
[{"id":"...","domicile":"Équipe A","exterieur":"Équipe B","score_dom":1,"score_ext":0,"minute":"62'","etat":"en_cours"}]
\`\`\``;
  }

  async function fetchScores(apiKey, model, matches) {
    if (!matches.length) return [];
    const key = matches.map((m) => m.id).sort().join(',');
    if (cache.key === key && Date.now() - cache.at < 45000) return cache.data;

    const now = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const body = {
      contents: [{ role: 'user', parts: [{ text: buildPrompt(matches, now) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0 }
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
    const parsed = extractJSON(text);
    const out = Array.isArray(parsed) ? parsed : [];
    cache = { at: Date.now(), key, data: out };
    return out;
  }

  function extractJSON(text) {
    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    const cands = [];
    if (fenced) cands.push(fenced[1]);
    const a = text.indexOf('['), b = text.lastIndexOf(']');
    if (a !== -1 && b > a) cands.push(text.slice(a, b + 1));
    for (const c of cands) { try { return JSON.parse(c); } catch (_) {} }
    return null;
  }

  return { fetchScores };
})();
