/* ==========================================================================
   BetSmart AI — Elo tennis (données ouvertes Jeff Sackmann / Tennis Abstract)
   Calcule un Elo par surface (dur/terre/gazon) à partir des CSV de matchs
   ATP + WTA des dernières saisons, et renvoie une table compacte des joueurs
   ACTIFS (nom normalisé → ratings), mise en cache CDN 24 h.

   /api/tennis            → { ok, updated, players: { "nom": {e,h,c,g,n} } }
   Données publiques (licence ouverte). Usage privé côté app.
   ========================================================================== */
'use strict';

// raw.githubusercontent est rate-limité (404) depuis les IP datacenter → on essaie
// plusieurs miroirs CDN de GitHub dans l'ordre.
const mirrors = (repo, file) => [
  `https://cdn.jsdelivr.net/gh/JeffSackmann/${repo}@master/${file}`,
  `https://cdn.statically.io/gh/JeffSackmann/${repo}/master/${file}`,
  `https://raw.githack.com/JeffSackmann/${repo}/master/${file}`,
  `https://raw.githubusercontent.com/JeffSackmann/${repo}/master/${file}`
];
const ATP = (y) => mirrors('tennis_atp', `atp_matches_${y}.csv`);
const WTA = (y) => mirrors('tennis_wta', `wta_matches_${y}.csv`);

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const DBG = [];
async function fetchOne(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'BetSmartAI/1.0', 'Accept': 'text/plain,*/*' } });
    clearTimeout(to);
    const host = (url.split('/')[2] || '').split('.').slice(-2).join('.');
    if (!r.ok) { DBG.push(`${host}:HTTP${r.status}`); return null; }
    const t = await r.text();
    if (!t || t.length < 100) { DBG.push(`${host}:empty`); return null; }
    DBG.push(`${host}:${t.length}b`);
    return t;
  } catch (e) { clearTimeout(to); DBG.push(`err:${String((e && e.message) || e).slice(0, 30)}`); return null; }
}
async function fetchCsv(urls) {
  for (const u of urls) { const t = await fetchOne(u); if (t) return t; }
  return null;
}

function surfKey(s) {
  const t = (s || '').toLowerCase();
  if (t.startsWith('clay')) return 'C';
  if (t.startsWith('grass')) return 'G';
  return 'H'; // Hard + Carpet + inconnu
}
const K = (n) => 250 / Math.pow(n + 5, 0.4); // K décroissant (stabilité), façon 538

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const Y = new Date().getFullYear();
    const years = [Y, Y - 1, Y - 2, Y - 3];
    const urls = [];
    years.forEach((y) => { urls.push(ATP(y)); urls.push(WTA(y)); });

    const texts = await Promise.all(urls.map(fetchCsv));
    // Rassemble toutes les lignes de match { w, l, surf, date }
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
        const w = c[iW], l = c[iL];
        if (!w || !l) continue;
        rows.push({ w, l, s: surfKey(c[iS]), d: parseInt(c[iD], 10) || 0 });
      }
    });
    if (req.query && req.query.debug) return res.status(200).json({ ok: rows.length > 0, rows: rows.length, files: DBG });
    if (!rows.length) return res.status(200).json({ ok: false, error: 'aucune donnée de match', files: DBG });

    rows.sort((a, b) => a.d - b.d); // chronologique

    const R = {};
    const get = (name) => R[name] || (R[name] = { all: 1500, H: 1500, C: 1500, G: 1500, n: 0, nH: 0, nC: 0, nG: 0, last: 0 });

    for (const m of rows) {
      const W = get(m.w), L = get(m.l), sk = m.s;
      // Overall
      const eW = 1 / (1 + Math.pow(10, (L.all - W.all) / 400));
      W.all += K(W.n) * (1 - eW);
      L.all -= K(L.n) * (1 - eW);
      // Surface
      const eWs = 1 / (1 + Math.pow(10, (L[sk] - W[sk]) / 400));
      W[sk] += K(W['n' + sk]) * (1 - eWs);
      L[sk] -= K(L['n' + sk]) * (1 - eWs);
      W.n++; L.n++; W['n' + sk]++; L['n' + sk]++;
      W.last = Math.max(W.last, m.d); L.last = Math.max(L.last, m.d);
    }

    // Ne garde que les joueurs actifs (dernier match cette année ou l'an dernier)
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
