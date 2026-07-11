/* ==========================================================================
   BetSmart AI — Capture périodique des cotes (steam / mouvement de ligne)
   Appelé par un planificateur externe (GitHub Actions, ~30 min).
   Snapshoote les probabilités justes (dévig) des principaux marchés des
   matchs à venir et les écrit dans Firestore : oddsSnapshots/{rencId}.
   L'app lit ensuite ces snapshots pour détecter le mouvement de ligne.
   Usage privé.
   ========================================================================== */
'use strict';

const crypto = require('crypto');

const COTEUR = 'https://www.coteur.com';
const ODDS_API = 'https://oddsv2.coteur.com/odds/getFullOdds';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const SPORT_PAGES = ['cotes-foot', 'cotes-tennis', 'cotes-basket'];

// Config Firestore (valeurs publiques du projet)
const FB_PROJECT = 'betsmart-ai-6d732';
const FB_KEY = 'AIzaSyDx_SFq0peV2q7dKM4rJmGiTuJjNdK04WM';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

/* ---- Token AES (identique à /api/coteur) ---- */
function evpKDF(pass, salt, kl, il) {
  let d = Buffer.alloc(0), b = Buffer.alloc(0);
  while (d.length < kl + il) { const h = crypto.createHash('md5'); h.update(Buffer.concat([b, Buffer.from(pass, 'utf8'), salt])); b = h.digest(); d = Buffer.concat([d, b]); }
  return { key: d.subarray(0, kl), iv: d.subarray(kl, kl + il) };
}
function token() {
  const t = new Date(); const utc = new Date(t.getTime() + 60000 * t.getTimezoneOffset());
  const salt = crypto.randomBytes(8); const { key, iv } = evpKDF('1231', salt, 32, 16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([c.update(utc.toLocaleDateString('fr-FR'), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'utf8'), salt, ct]).toString('base64');
}

/* ---- Dévigorisation ---- */
function devig(src, keys) {
  const imp = {}; let s = 0;
  for (const k of keys) { const o = src?.[k]; if (o && +o.cote > 1) { imp[k] = 1 / +o.cote; s += imp[k]; } }
  if (s <= 0) return null;
  const f = {}; for (const k of Object.keys(imp)) f[k] = Math.round(imp[k] / s * 1000) / 1000;
  return f;
}

async function getOdds(rencId) {
  const r = await fetch(`${ODDS_API}/${rencId}`, { headers: { token: token(), 'User-Agent': UA, Accept: 'application/json', Referer: `${COTEUR}/`, Origin: COTEUR } });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (_) { return null; }
}

/** Probabilités justes des marchés clés d'un match (1n2/12 + OU 2.5). */
function keyMarkets(raw) {
  const out = {};
  for (const e of raw.odds || []) {
    const src = e.best || e.bestfr;
    if (!src) continue;
    if (e.typename === '1n2' && !e.special) { const f = devig(src, ['1', '0', '2']); if (f) out['1n2'] = f; }
    else if (e.typename === '12' && !e.special) { const f = devig(src, ['1', '2']); if (f) out['12'] = f; }
    else if (e.typename === 'OU' && e.special === '2-5') { const f = devig(src, ['2', '3']); if (f) out['OU2-5'] = f; }
  }
  return out;
}

/* ---- Écriture Firestore (REST, règle ouverte sur oddsSnapshots) ---- */
async function writeSnapshot(rencId, payload) {
  const url = `${FS_BASE}/oddsSnapshots/${rencId}?key=${FB_KEY}&updateMask.fieldPaths=data&updateMask.fieldPaths=updatedAt`;
  const body = { fields: { data: { stringValue: JSON.stringify(payload) }, updatedAt: { integerValue: String(Date.now()) } } };
  const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.status;
}

module.exports = async (req, res) => {
  // Protection légère de l'endpoint
  const secret = process.env.CRON_SECRET;
  if (secret && req.query.secret !== secret) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const dryRun = req.query.dry === '1';
  const cap = Math.max(1, Math.min(24, parseInt(req.query.n, 10) || 24));
  const pages = req.query.page ? [String(req.query.page)] : SPORT_PAGES;
  const t0 = Date.now();
  try {
    // 1) Inventaire des rencId à venir
    const rencIds = [];
    for (const page of pages) {
      try {
        const html = await (await fetch(`${COTEUR}/${page}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR' } })).text();
        const ids = [...new Set((html.match(/\/cote\/[a-z0-9-]+-(\d+)/gi) || []).map((h) => (h.match(/(\d+)$/) || [])[1]))].filter(Boolean);
        rencIds.push(...ids.slice(0, 10));
      } catch (_) {}
    }
    const unique = [...new Set(rencIds)].slice(0, cap);

    // 2) Snapshot des marchés clés, en parallèle limité
    let written = 0; const results = [];
    const CONC = 8;
    for (let i = 0; i < unique.length; i += CONC) {
      const batch = unique.slice(i, i + CONC);
      await Promise.all(batch.map(async (rid) => {
        try {
          const raw = await getOdds(rid);
          if (!raw || !Array.isArray(raw.odds)) return;
          const markets = keyMarkets(raw);
          if (!Object.keys(markets).length) return;
          const payload = {
            home: raw.info?.teamDom?.equipeNom || '', away: raw.info?.teamExt?.equipeNom || '',
            at: Date.now(), markets
          };
          if (dryRun) { if (results.length < 3) results.push({ rid, payload }); return; }
          const st = await writeSnapshot(rid, payload);
          if (st >= 200 && st < 300) written++; else results.push({ rid, status: st });
        } catch (_) {}
      }));
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, matches: unique.length, written, ms: Date.now() - t0, sample: results.slice(0, 3) });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
};
