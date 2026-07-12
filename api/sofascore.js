/* ==========================================================================
   BetSmart AI — Proxy vers l'API SofaScore (Edge Runtime)
   L'IP des lambdas Node de Vercel est bloquée par Cloudflare (403). Les Edge
   Functions sortent par un réseau différent → meilleure chance d'aboutir.
   Usage : /api/sofascore?p=<chemin API v1 encodé>  (usage privé)
   ========================================================================== */
export const config = { runtime: 'edge' };

const BASE = 'https://api.sofascore.com/api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const ALLOWED = ['/search/', '/team/', '/event/', '/tournament/', '/unique-tournament/'];

const json = (obj, cache) => new Response(JSON.stringify(obj), {
  status: 200,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': cache || 'no-store'
  }
});

export default async function handler(req) {
  const p = new URL(req.url).searchParams.get('p') || '';
  if (!p.startsWith('/') || !ALLOWED.some((a) => p.startsWith(a))) {
    return json({ ok: false, error: 'chemin non autorisé' });
  }
  try {
    const r = await fetch(`${BASE}${p}`, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Referer': 'https://www.sofascore.com/',
        'Origin': 'https://www.sofascore.com',
        'Cache-Control': 'no-cache'
      }
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* corps non JSON */ }
    // Un corps qui contient un objet "error" (ex : {error:{code:403}}) = échec.
    if (!r.ok || !data || data.error) {
      return json({ ok: false, error: `sofascore ${r.status}`, blocked: !!(data && data.error) });
    }
    return json({ ok: true, data }, 's-maxage=300, stale-while-revalidate=600');
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}
