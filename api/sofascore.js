/* ==========================================================================
   BetSmart AI — Proxy serverless vers l'API SofaScore (données factuelles)
   Objectif : fournir au Radar IA des FAITS réels et récents (forme, buts,
   H2H, classement) plutôt que de laisser le modèle inventer.

   Usage : /api/sofascore?p=<chemin API v1 encodé>
     ex : /api/sofascore?p=%2Fsearch%2Fall%3Fq%3Dpsg
          /api/sofascore?p=%2Fteam%2F1644%2Fevents%2Flast%2F0

   Repli : si l'IP serveur est bloquée (Cloudflare), on passe par des proxies
   CORS publics. Usage strictement privé (contraire aux CGU de SofaScore).
   ========================================================================== */
'use strict';

const BASE = 'https://api.sofascore.com/api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// Seuls ces préfixes de chemin sont autorisés (sécurité : pas de SSRF ouvert)
const ALLOWED = ['/search/', '/team/', '/event/', '/tournament/', '/unique-tournament/'];

const PUBLIC_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`
];

async function fetchJson(url, { timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Referer': 'https://www.sofascore.com/',
        'Origin': 'https://www.sofascore.com'
      }
    });
    const text = await r.text();
    try { return { ok: r.ok, data: JSON.parse(text) }; } catch (_) { return { ok: false, data: null }; }
  } finally { clearTimeout(to); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const p = String((req.query && req.query.p) || '');

  if (!p.startsWith('/') || !ALLOWED.some((a) => p.startsWith(a))) {
    return res.status(400).json({ ok: false, error: 'chemin non autorisé' });
  }

  const target = `${BASE}${p}`;
  try {
    // 1) Accès direct
    let out = await fetchJson(target);
    // 2) Repli proxies publics si bloqué / échec
    if (!out.ok || !out.data) {
      for (const wrap of PUBLIC_PROXIES) {
        try {
          const r = await fetchJson(wrap(target), { timeout: 9000 });
          if (r.ok && r.data) { out = r; break; }
        } catch (_) { /* proxy suivant */ }
      }
    }
    if (!out.data) return res.status(200).json({ ok: false, error: 'indisponible' });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ ok: true, data: out.data });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
};
