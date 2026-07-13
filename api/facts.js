/* ==========================================================================
   BetSmart AI — Proxy vers les API api-sports.io (multi-sports)
   Une seule clé api-sports.io couvre plusieurs sports, chacun sur son hôte.
   Source factuelle FIABLE (auth par clé → pas de blocage d'IP) : forme, buts/
   points, xG (foot), H2H, classement → le Radar ne devine plus.

   Usage : /api/facts?ep=<endpoint+query encodé>&key=<clé>&sp=<sport>
     ex : /api/facts?ep=teams%3Fsearch%3Dlakers&key=xxx&sp=basketball
   Usage privé.
   ========================================================================== */
'use strict';

const HOSTS = {
  football: 'https://v3.football.api-sports.io',
  basketball: 'https://v1.basketball.api-sports.io',
  hockey: 'https://v1.hockey.api-sports.io',
  baseball: 'https://v1.baseball.api-sports.io',
  rugby: 'https://v1.rugby.api-sports.io',
  volleyball: 'https://v1.volleyball.api-sports.io',
  handball: 'https://v1.handball.api-sports.io'
};

// Endpoints autorisés (préfixes) — foot (v3) + sports d'équipe (v1)
const ALLOWED = [
  'teams', 'standings', 'injuries',
  'fixtures', 'fixtures/statistics', 'fixtures/headtohead',
  'games', 'games/statistics'
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ep = String((req.query && req.query.ep) || '');
  const key = String((req.query && req.query.key) || '');
  const sp = String((req.query && req.query.sp) || 'football');
  const base = HOSTS[sp] || HOSTS.football;

  if (!key) return res.status(400).json({ ok: false, error: 'clé api-sports manquante' });
  const path = ep.split('?')[0];
  if (!ALLOWED.some((a) => path === a)) return res.status(400).json({ ok: false, error: 'endpoint non autorisé' });

  try {
    const r = await fetch(`${base}/${ep}`, { headers: { 'x-apisports-key': key, 'Accept': 'application/json' } });
    const data = await r.json().catch(() => null);
    if (!data) return res.status(200).json({ ok: false, error: 'réponse illisible' });
    const errs = data.errors;
    const hasErr = errs && ((Array.isArray(errs) && errs.length) || (typeof errs === 'object' && Object.keys(errs).length));
    if (hasErr) return res.status(200).json({ ok: false, error: typeof errs === 'string' ? errs : JSON.stringify(errs) });
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({ ok: true, response: data.response || [], results: data.results });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
