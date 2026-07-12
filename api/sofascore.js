/* ==========================================================================
   BetSmart AI — Proxy vers l'API SofaScore (best-effort)
   Note : l'IP des serveurs Vercel est bloquée par Cloudflare (403) et les
   proxies CORS publics aussi. Cet endpoint échoue donc proprement (ok:false,
   sans mise en cache) → le client retombe sur l'analyse groundée. La source
   factuelle fiable est fournie par /api/facts (API officielle avec clé).
   ========================================================================== */
'use strict';

const BASE = 'https://api.sofascore.com/api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const ALLOWED = ['/search/', '/team/', '/event/', '/tournament/', '/unique-tournament/'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const p = String((req.query && req.query.p) || '');
  if (!p.startsWith('/') || !ALLOWED.some((a) => p.startsWith(a))) {
    return res.status(400).json({ ok: false, error: 'chemin non autorisé' });
  }
  try {
    const r = await fetch(`${BASE}${p}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://www.sofascore.com/' }
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch (_) {}
    if (!r.ok || !data || data.error) return res.status(200).json({ ok: false, error: `bloqué (${r.status})` });
    return res.status(200).json({ ok: true, data });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
