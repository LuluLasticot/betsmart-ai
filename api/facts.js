/* ==========================================================================
   BetSmart AI — Proxy vers API-Football (api-sports.io)
   Source factuelle FIABLE (l'authentification par clé évite tout blocage d'IP).
   Fournit forme, buts, xG, H2H, classement, blessures → le Radar ne devine plus.

   Usage : /api/facts?ep=<endpoint+query encodé>&key=<clé API-Football>
     ex : /api/facts?ep=teams%3Fsearch%3Dlevski&key=xxxx
          /api/facts?ep=fixtures%3Fteam%3D619%26last%3D6&key=xxxx

   La clé est celle de l'utilisateur (plan gratuit). Usage privé.
   ========================================================================== */
'use strict';

const BASE = 'https://v3.football.api-sports.io';
// Endpoints autorisés (préfixes) — pas de SSRF ouvert
const ALLOWED = ['teams', 'fixtures', 'fixtures/statistics', 'fixtures/headtohead', 'standings', 'injuries', 'teams/statistics'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ep = String((req.query && req.query.ep) || '');
  const key = String((req.query && req.query.key) || '');

  if (!key) return res.status(400).json({ ok: false, error: 'clé API-Football manquante' });
  const path = ep.split('?')[0];
  if (!ALLOWED.some((a) => path === a)) {
    return res.status(400).json({ ok: false, error: 'endpoint non autorisé' });
  }

  try {
    const r = await fetch(`${BASE}/${ep}`, {
      headers: { 'x-apisports-key': key, 'Accept': 'application/json' }
    });
    const data = await r.json().catch(() => null);
    if (!data) return res.status(200).json({ ok: false, error: 'réponse illisible' });
    // API-Football renvoie { errors: {...}, response: [...] }
    const errs = data.errors;
    const hasErr = errs && ((Array.isArray(errs) && errs.length) || (typeof errs === 'object' && Object.keys(errs).length));
    if (hasErr) return res.status(200).json({ ok: false, error: JSON.stringify(errs) });
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({ ok: true, response: data.response || [], results: data.results });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
