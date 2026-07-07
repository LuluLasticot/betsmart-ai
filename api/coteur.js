/* ==========================================================================
   BetSmart AI — Fonction serverless Vercel : proxy privé vers coteur.com
   Résout définitivement : pas de CORS, pas de proxy public, token en header,
   cache edge, et log de la vraie réponse getFullOdds pour figer le mapping.

   Endpoints (GET) :
     /api/coteur?type=ping                 → { ok: true }
     /api/coteur?type=list&page=cotes-foot → { ok, html }
     /api/coteur?type=odds&id=123456       → { ok, data }   (data = réponse coteur)

   Usage strictement privé (scraping contraire aux CGU de coteur.com).
   ========================================================================== */
'use strict';

const crypto = require('crypto');

const COTEUR = 'https://www.coteur.com';
const ODDS_API = 'https://oddsv2.coteur.com/odds/getFullOdds';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const ALLOWED_PAGES = new Set(['cotes-foot', 'cotes-tennis', 'cotes-basket', 'cotes-rugby', 'cotes-handball', 'cotes-volley', 'cotes-hockey']);

/* ---- Token AES quotidien, format OpenSSL (compatible CryptoJS.AES) ---- */
function evpBytesToKey(passphrase, salt, keyLen, ivLen) {
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    const md5 = crypto.createHash('md5');
    md5.update(Buffer.concat([block, Buffer.from(passphrase, 'utf8'), salt]));
    block = md5.digest();
    derived = Buffer.concat([derived, block]);
  }
  return { key: derived.subarray(0, keyLen), iv: derived.subarray(keyLen, keyLen + ivLen) };
}

function generateToken() {
  const t = new Date();
  const utc = new Date(t.getTime() + 60000 * t.getTimezoneOffset());
  const dateStr = utc.toLocaleDateString('fr-FR'); // "JJ/MM/AAAA"
  const salt = crypto.randomBytes(8);
  const { key, iv } = evpBytesToKey('1231', salt, 32, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(dateStr, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'utf8'), salt, ct]).toString('base64');
}

let loggedShape = false; // log une seule fois la structure getFullOdds par instance

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { type = '', page = '', id = '' } = req.query || {};

  try {
    if (type === 'ping') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true });
    }

    if (type === 'list') {
      if (!ALLOWED_PAGES.has(page)) return res.status(400).json({ ok: false, error: 'page invalide' });
      const r = await fetch(`${COTEUR}/${page}`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9', 'Accept': 'text/html' }
      });
      const html = await r.text();
      res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=300');
      return res.status(200).json({ ok: r.ok, html });
    }

    if (type === 'page') {
      const slug = String(req.query.slug || '').replace(/[^a-z0-9-]/gi, '');
      const r = await fetch(`${COTEUR}/cote/${slug}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9', 'Accept': 'text/html' } });
      const html = await r.text();
      res.setHeader('Cache-Control', 'no-store');
      // renvoie les portions autour des noms de books connus
      const idx = [];
      for (const kw of ['Winamax', 'Betclic', 'Unibet', 'data-book', 'bookmaker-', 'cote-']) {
        let p = html.indexOf(kw);
        if (p >= 0) idx.push(html.slice(Math.max(0, p - 120), p + 240));
      }
      return res.status(200).json({ ok: true, len: html.length, around: idx });
    }

    if (type === 'map') {
      // Cherche le mapping bookId→nom dans le HTML + bundles JS de coteur
      const home = await (await fetch(`${COTEUR}/cotes-foot`, { headers: { 'User-Agent': UA } })).text();
      const scripts = [...home.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/gi)].map((m) => m[1]);
      const abs = scripts.map((s) => (s.startsWith('http') ? s : `${COTEUR}${s.startsWith('/') ? '' : '/'}${s}`));
      const found = {};
      const hits = [];
      const KNOWN = ['winamax', 'betclic', 'unibet', 'pmu', 'parionssport', 'zebet', 'genybet', 'vbet', 'olybet', 'betsson', 'bwin', 'feelingbet', 'netbet', 'pinnacle', 'bet365', 'betway'];
      for (const u of abs.slice(0, 25)) {
        try {
          const js = await (await fetch(u, { headers: { 'User-Agent': UA } })).text();
          if (!/winamax|betclic|bookmaker/i.test(js)) continue;
          // motifs {id:22,...,nom:"Winamax"...} ou "Winamax":22 ou variantes
          const re = /\{[^{}]*?\b(?:id|bookId|bookmakerId)\b["'\s:]+(\d+)[^{}]*?\b(?:nom|name|slug|label)\b["'\s:]+["']([^"']{2,30})["'][^{}]*?\}/gi;
          let m; while ((m = re.exec(js)) && hits.length < 120) hits.push({ id: +m[1], name: m[2] });
          // motif inverse nom puis id
          const re2 = /\{[^{}]*?\b(?:nom|name|slug|label)\b["'\s:]+["']([^"']{2,30})["'][^{}]*?\b(?:id|bookId|bookmakerId)\b["'\s:]+(\d+)[^{}]*?\}/gi;
          while ((m = re2.exec(js)) && hits.length < 240) hits.push({ id: +m[2], name: m[1] });
          if (hits.length) found[u] = hits.filter((h) => KNOWN.includes(String(h.name).toLowerCase())).slice(0, 40);
        } catch (_) {}
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, scripts: abs.length, hits: hits.slice(0, 60), knownMatches: found });
    }

    if (type === 'probe') {
      const rid = String(req.query.id || '').replace(/\D/g, '') || '1596595';
      const tok = generateToken();
      const H = { 'token': tok, 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `${COTEUR}/`, 'Origin': COTEUR };
      const candidates = [
        `https://oddsv2.coteur.com/odds/getOdds/${rid}`,
        `https://oddsv2.coteur.com/odds/getAllOdds/${rid}`,
        `https://oddsv2.coteur.com/odds/getBookmakerOdds/${rid}`,
        `https://oddsv2.coteur.com/odds/detail/${rid}`,
        `https://oddsv2.coteur.com/odds/getFullOdds/${rid}?all=1`,
        `https://oddsv2.coteur.com/bookmaker`,
        `https://oddsv2.coteur.com/bookmaker/getAll`,
        `https://oddsv2.coteur.com/bookmakers/fr`
      ];
      const out = {};
      for (const u of candidates) {
        try {
          const r = await fetch(u, { headers: H });
          const txt = await r.text();
          out[u] = { status: r.status, sample: txt.slice(0, 500) };
        } catch (e) { out[u] = { error: String(e && e.message) }; }
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, out });
    }

    if (type === 'odds') {
      if (!/^\d+$/.test(String(id))) return res.status(400).json({ ok: false, error: 'id invalide' });
      const token = generateToken();
      const r = await fetch(`${ODDS_API}/${id}`, {
        headers: {
          'token': token,
          'User-Agent': UA,
          'Accept': 'application/json',
          'Referer': `${COTEUR}/`,
          'Origin': COTEUR
        }
      });
      // coteur renvoie parfois 500 avec un corps JSON : on parse quand même
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { /* corps non-JSON */ }

      if (!loggedShape && data && Array.isArray(data.odds)) {
        loggedShape = true;
        const sample = data.odds.slice(0, 2);
        console.log('[coteur] getFullOdds shape:', JSON.stringify(sample).slice(0, 1800));
        console.log('[coteur] typenames:', data.odds.map((o) => o.typename).join(', '));
      }

      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=180');
      return res.status(200).json({ ok: !!data, data });
    }

    return res.status(400).json({ ok: false, error: 'type inconnu' });
  } catch (err) {
    console.error('[coteur] erreur:', err);
    return res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
};
