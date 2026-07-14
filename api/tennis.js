/* ==========================================================================
   BetSmart AI — Elo tennis (calcul SERVEUR via l'API GitHub)
   Le navigateur de l'utilisateur (et raw.githubusercontent) peuvent être
   bloqués/rate-limités par GitHub. On calcule donc côté serveur en récupérant
   les CSV Sackmann via api.github.com (contents, base64) — hôte différent,
   qui répond aux serveurs. On renvoie une table compacte des joueurs actifs,
   mise en cache CDN 24 h. Le client ne lit qu'un petit JSON.
   ========================================================================== */
'use strict';

const API = (repo, file) => `https://api.github.com/repos/JeffSackmann/${repo}/contents/${file}`;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const surfKey = (s) => { const t = (s || '').toLowerCase(); return t.startsWith('clay') ? 'C' : t.startsWith('grass') ? 'G' : 'H'; };
const K = (n) => 250 / Math.pow(n + 5, 0.4);

const DBG = [];
async function fetchCsv(repo, file, token) {
  const url = API(repo, file);
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8500);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'BetSmartAI',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    clearTimeout(to);
    if (!r.ok) { DBG.push(`${file}:HTTP${r.status}`); return null; }
    const j = await r.json();
    if (!j || !j.content) { DBG.push(`${file}:nocontent`); return null; }
    const csv = Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8');
    DBG.push(`${file}:${csv.length}b`);
    return csv;
  } catch (e) { DBG.push(`${file}:ERR`); return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const token = String((req.query && req.query.token) || process.env.GITHUB_TOKEN || '');
    const Y = new Date().getFullYear();
    const years = [Y - 1, Y - 2];
    const jobs = [];
    years.forEach((y) => { jobs.push(fetchCsv('tennis_atp', `atp_matches_${y}.csv`, token)); jobs.push(fetchCsv('tennis_wta', `wta_matches_${y}.csv`, token)); });
    const texts = await Promise.all(jobs);

    const rows = [];
    texts.forEach((txt) => {
      if (!txt) return;
      const lines = txt.split('\n');
      const head = lines[0].split(',');
      const iS = head.indexOf('surface'), iD = head.indexOf('tourney_date');
      const iW = head.indexOf('winner_name'), iL = head.indexOf('loser_name');
      if (iW < 0 || iL < 0) return;
      for (let k = 1; k < lines.length; k++) {
        const c = lines[k].split(',');
        if (c.length < head.length) continue;
        if (!c[iW] || !c[iL]) continue;
        rows.push({ w: c[iW], l: c[iL], s: surfKey(c[iS]), d: parseInt(c[iD], 10) || 0 });
      }
    });
    if (req.query && req.query.debug) return res.status(200).json({ ok: rows.length > 0, rows: rows.length, tokenReçu: !!token, files: DBG });
    if (!rows.length) return res.status(200).json({ ok: false, error: token ? 'GitHub a refusé la lecture' : 'token manquant', tokenReçu: !!token, files: DBG });

    rows.sort((a, b) => a.d - b.d);
    const R = {};
    const get = (n) => R[n] || (R[n] = { all: 1500, H: 1500, C: 1500, G: 1500, n: 0, nH: 0, nC: 0, nG: 0, last: 0 });
    for (const m of rows) {
      const W = get(m.w), L = get(m.l), sk = m.s;
      const eW = 1 / (1 + Math.pow(10, (L.all - W.all) / 400));
      W.all += K(W.n) * (1 - eW); L.all -= K(L.n) * (1 - eW);
      const eWs = 1 / (1 + Math.pow(10, (L[sk] - W[sk]) / 400));
      W[sk] += K(W['n' + sk]) * (1 - eWs); L[sk] -= K(L['n' + sk]) * (1 - eWs);
      W.n++; L.n++; W['n' + sk]++; L['n' + sk]++;
      W.last = Math.max(W.last, m.d); L.last = Math.max(L.last, m.d);
    }
    const cutoff = (Y - 1) * 10000;
    const players = {};
    let n = 0;
    for (const [name, r] of Object.entries(R)) {
      if (r.last < cutoff || r.n < 5) continue;
      players[norm(name)] = { e: Math.round(r.all), h: Math.round(r.H), c: Math.round(r.C), g: Math.round(r.G), n: r.n };
      n++;
    }
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
    return res.status(200).json({ ok: true, updated: Date.now(), count: n, players });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
