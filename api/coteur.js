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

    if (type === 'nav') {
      const cands = ['cotes-football-us', 'cotes-nfl', 'cotes-us-football', 'cotes-footus', 'cotes-american-football',
        'cotes-rugby-league', 'cotes-treize', 'cotes-rugby-xiii', 'cotes-xiii', 'cotes-rugby-13-treize',
        'cotes-hand', 'cotes-handball-fr', 'cotes-hockey-sur-glace', 'cotes-hockey-glace'];
      const out = {};
      for (const p of cands) {
        try {
          const r = await fetch(`${COTEUR}/${p}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR', 'Accept': 'text/html' } });
          const html = await r.text();
          out[p] = { status: r.status, matches: (html.match(/\/cote\/[a-z0-9-]+-\d+/gi) || []).length };
        } catch (e) { out[p] = { error: String(e && e.message) }; }
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, out });
    }

    if (type === 'score') {
      // Score + statut en direct depuis la page match (rendus côté serveur)
      const slug = String(req.query.slug || '').replace(/[^a-z0-9-]/gi, '');
      if (!slug) return res.status(400).json({ ok: false, error: 'slug requis' });
      const r = await fetch(`${COTEUR}/cote/${slug}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9', 'Accept': 'text/html' } });
      const html = await r.text();
      // <span class="display-4 fw-bold text-primary"> 0 - 1 </span>
      const sm = html.match(/display-4[^>]*text-primary[^>]*>\s*(\d+)\s*[-–]\s*(\d+)\s*</i);
      // badge de statut : "EN DIRECT • Mi-temps", "Terminé", etc.
      const badge = html.match(/badge\s+bg-(?:danger|success|secondary|warning)[^>]*>\s*([^<]+?)\s*</i);
      const statusTxt = badge ? badge[1].replace(/\s+/g, ' ').trim() : null;
      const live = /direct/i.test(statusTxt || '');
      const finished = /termin/i.test(statusTxt || '');
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      return res.status(200).json({
        ok: true,
        score_dom: sm ? +sm[1] : null,
        score_ext: sm ? +sm[2] : null,
        status: statusTxt,
        live, finished
      });
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
