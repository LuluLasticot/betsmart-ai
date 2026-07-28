/* ==========================================================================
   BetSmart AI — Intégration Google Gemini
   1. Smart Scan : capture de ticket → JSON structuré (Vision)
   2. Coach IA  : résumé statistique → insights en langage naturel
   ========================================================================== */
'use strict';

const Gemini = (() => {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

  /* ------------------------------------------------------------------
     Découverte automatique des modèles disponibles
     Google retire régulièrement d'anciens modèles (« no longer available to
     new users ») et en publie de nouveaux. Plutôt que de figer un nom dans le
     code, on interroge l'API pour choisir le meilleur modèle rapide (flash) et
     le meilleur modèle approfondi (pro) réellement accessibles avec LA clé de
     l'utilisateur. Résultat mis en cache 24 h.
     ------------------------------------------------------------------ */
  const MODELS_KEY = 'betsmart.models';
  const EXCLUDE = /embedding|aqa|imagen|image|tts|audio|live|gemma|veo|learnlm|robotics/i;

  const readCache = () => { try { return JSON.parse(localStorage.getItem(MODELS_KEY) || 'null'); } catch (_) { return null; } };
  const writeCache = (v) => { try { localStorage.setItem(MODELS_KEY, JSON.stringify(v)); } catch (_) {} };
  const clearModelCache = () => { try { localStorage.removeItem(MODELS_KEY); } catch (_) {} };

  /** Score un modèle : version décroissante, stable préféré au preview/exp. */
  function score(id) {
    const v = parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    const preview = /preview|exp|-\d{4}$|latest/i.test(id) ? 1 : 0;
    const lite = /lite/i.test(id) ? 1 : 0;
    return { v, preview, lite };
  }
  const better = (a, b) => {
    if (!a) return true;
    const sa = score(a), sb = score(b);
    if (sb.lite !== sa.lite) return sb.lite < sa.lite;       // éviter les « lite »
    if (sb.preview !== sa.preview) return sb.preview < sa.preview; // stable d'abord
    if (sb.v !== sa.v) return sb.v > sa.v;                    // version la plus récente
    return b.length < a.length;                               // alias court (sans date)
  };

  /** { flash, pro } — modèles réellement utilisables avec cette clé. */
  async function resolveModels(apiKey, { force = false } = {}) {
    if (!apiKey) return null;
    const cached = readCache();
    if (!force && cached && Date.now() - cached.at < 86400e3 && cached.flash) return cached;

    const res = await fetch(`${BASE}?key=${encodeURIComponent(apiKey)}&pageSize=200`);
    if (!res.ok) throw new Error(`Impossible de lister les modèles (${res.status})`);
    const data = await res.json();
    const ids = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((id) => id.startsWith('gemini') && !EXCLUDE.test(id));

    let flash = null, pro = null;
    for (const id of ids) {
      if (/flash/i.test(id) && better(flash, id)) flash = id;
      if (/pro/i.test(id) && better(pro, id)) pro = id;
    }
    // Aucun « flash » ? on prend le meilleur modèle générique disponible.
    if (!flash) for (const id of ids) if (better(flash, id)) flash = id;
    if (!flash) throw new Error('Aucun modèle Gemini disponible avec cette clé.');

    const out = { at: Date.now(), flash, pro: pro || flash, all: ids };
    writeCache(out);
    return out;
  }

  /** Le message d'un modèle retiré/introuvable → on redécouvre et on réessaie. */
  const isModelGone = (msg) => /no longer available|not found|not supported|is not available/i.test(String(msg || ''));

  /* ------------------------------------------------------------------
     Gestion du quota (free tier : ~5 requêtes/min et ~20/jour)
     Le quota est la ressource rare : on l'économise activement plutôt que
     d'enchaîner des tentatives qui échouent et le consomment pour rien.
     ------------------------------------------------------------------ */
  const CALLS_KEY = 'betsmart.geminiCalls';
  const RPM = 5;                       // requêtes/minute (free tier)
  const RPD = 20;                      // requêtes/jour (free tier, modèle courant)

  const readCalls = () => { try { return JSON.parse(localStorage.getItem(CALLS_KEY) || '[]'); } catch (_) { return []; } };
  const writeCalls = (a) => { try { localStorage.setItem(CALLS_KEY, JSON.stringify(a.slice(-200))); } catch (_) {} };
  const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  /** { minute, day, rpm, rpd } — consommation connue côté client. */
  function usage() {
    const now = Date.now();
    const calls = readCalls().filter((t) => now - t < 86400e3);
    return {
      minute: calls.filter((t) => now - t < 60e3).length,
      day: calls.filter((t) => t >= startOfDay()).length,
      rpm: RPM, rpd: RPD
    };
  }
  const recordCall = () => { const a = readCalls(); a.push(Date.now()); writeCalls(a); };

  /** Attend qu'un créneau se libère plutôt que de déclencher un 429 inutile. */
  async function waitForSlot({ onWait } = {}) {
    for (let i = 0; i < 3; i++) {
      const now = Date.now();
      const recent = readCalls().filter((t) => now - t < 60e3).sort((a, b) => a - b);
      if (recent.length < RPM) return;
      const wait = Math.max(1000, 60e3 - (now - recent[0]) + 500);
      onWait?.(Math.ceil(wait / 1000));
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** Délai conseillé par l'API (RetryInfo), en ms. */
  function retryDelayOf(err) {
    const d = (err?.error?.details || []).find((x) => String(x['@type'] || '').includes('RetryInfo'));
    const s = d && typeof d.retryDelay === 'string' ? parseFloat(d.retryDelay) : NaN;
    return isFinite(s) ? Math.min(Math.ceil(s * 1000) + 500, 70000) : null;
  }
  /** Quota JOURNALIER épuisé : inutile de réessayer, il faut attendre la remise à zéro. */
  function isDailyQuota(err) {
    const txt = JSON.stringify(err || {});
    return /PerDay|per day|daily/i.test(txt);
  }

  const quota = { usage, recordCall, waitForSlot, retryDelayOf, isDailyQuota, RPM, RPD };

  async function call(apiKey, model, parts, jsonSchema) {
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    };
    if (jsonSchema) body.generationConfig.responseSchema = jsonSchema;

    // Respect du quota (5 req/min en free tier) : on attend un créneau libre.
    await quota.waitForSlot();
    quota.recordCall();

    const res = await fetch(`${BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `Erreur API (${res.status})`;
      // Modèle retiré par Google → on redécouvre les modèles et on rejoue une fois
      if (isModelGone(msg) && !call._retrying) {
        try {
          call._retrying = true;
          const m = await resolveModels(apiKey, { force: true });
          const next = /pro/i.test(model) ? m.pro : m.flash;
          if (next && next !== model) return await call(apiKey, next, parts, jsonSchema);
        } finally { call._retrying = false; }
      }
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
     Scan d'une rencontre à analyser (capture d'écran → requête d'analyse)
     ------------------------------------------------------------------ */
  const MATCH_SCAN_PROMPT = `Tu es un extracteur. À partir d'une capture d'écran (page de bookmaker, comparateur de cotes, calendrier, appli de paris…), identifie LA rencontre principale que l'utilisateur veut faire analyser. S'il y a plusieurs matchs, choisis celui qui est le plus mis en avant / sélectionné / au centre. Retourne UNIQUEMENT un objet JSON :

{
  "sport": "Football | Tennis | Basketball | Baseball | Badminton | Volleyball | Rugby | Hockey | Handball | Boxe | MMA … ou null",
  "competition": "compétition / tournoi / championnat si visible, sinon null",
  "home": "équipe ou joueur 1 (domicile / à gauche), sinon null",
  "away": "équipe ou joueur 2 (extérieur / à droite), sinon null",
  "date": "YYYY-MM-DD si visible, sinon null",
  "time": "HH:MM si visible, sinon null",
  "query": "libellé court prêt à analyser : 'Équipe A – Équipe B' (ajoute le jour/heure si visibles). Utilise des noms complets et lisibles."
}

Règles : ne renvoie que le JSON. Si tu ne reconnais aucune rencontre, mets tous les champs à null.`;

  async function scanMatch(apiKey, model, base64Data, mimeType) {
    return call(apiKey, model, [
      { text: MATCH_SCAN_PROMPT },
      { inlineData: { mimeType, data: base64Data } }
    ]);
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

  return { scanTicket, scanMatch, coach, review, test, fileToBase64, resolveModels, clearModelCache, isModelGone, quota };
})();
