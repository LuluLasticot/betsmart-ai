#!/usr/bin/env python3
"""Construit data/football-elo-extra.json (championnats hors Europe).

Usage :
    python3 scripts/build_football_extra.py <fichier1.csv> [<fichier2.csv> ...] [--out sortie.json]

Chaque fichier est un CSV « extra » de football-data.co.uk (colonnes
Country,League,Season,Date,Time,Home,Away,HG,AG,Res,...). Les fichiers
peuvent contenir des lignes de préambule (URL, Content-Type) écrites par
web_fetch : on repère automatiquement la ligne d'en-tête « Country,League ».

Elo : départ 1500, K=20, avantage terrain 60, rejeu chronologique.
On ne retient que les équipes ayant disputé au moins 10 matchs.

Contrôles (sinon sys.exit(2)) :
  - au moins 30 équipes
  - Elo de chaque équipe entre 1200 et 1800
"""
import sys, csv, json, os, re, unicodedata, datetime, io

START, K, HFA = 1500.0, 20.0, 60.0
MIN_MATCHES = 10


def norm(s):
    s = unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', ' ', s)).strip()


def parse_date(d, t):
    d = (d or '').strip()
    base = None
    for fmt in ('%d/%m/%Y', '%d/%m/%y', '%Y-%m-%d'):
        try:
            base = datetime.datetime.strptime(d, fmt)
            break
        except ValueError:
            continue
    if base is None:
        return None
    tt = (t or '').strip()
    if re.match(r'^\d{1,2}:\d{2}$', tt):
        try:
            hh, mm = map(int, tt.split(':'))
            base = base.replace(hour=hh, minute=mm)
        except ValueError:
            pass
    return base


def load_rows(path):
    raw = open(path, encoding='utf-8-sig', errors='replace').read()
    lines = raw.split('\n')
    # trouver l'en-tête CSV
    hi = None
    for i, ln in enumerate(lines):
        if 'Country' in ln and 'League' in ln and 'Home' in ln:
            hi = i
            break
    if hi is None:
        return []
    reader = csv.DictReader(io.StringIO('\n'.join(lines[hi:])))
    out = []
    for r in reader:
        home, away = (r.get('Home') or '').strip(), (r.get('Away') or '').strip()
        hg, ag = (r.get('HG') or '').strip(), (r.get('AG') or '').strip()
        if not home or not away or hg == '' or ag == '':
            continue
        try:
            hg, ag = int(float(hg)), int(float(ag))
        except ValueError:
            continue
        dt = parse_date(r.get('Date'), r.get('Time'))
        out.append({
            'dt': dt or datetime.datetime.min,
            'league': (r.get('League') or '').strip(),
            'home': home, 'away': away, 'hg': hg, 'ag': ag,
        })
    return out


def main():
    args = [a for a in sys.argv[1:]]
    out_path = None
    if '--out' in args:
        i = args.index('--out')
        out_path = args[i + 1]
        del args[i:i + 2]
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if out_path is None:
        out_path = os.path.join(root, 'data', 'football-elo-extra.json')
    if not args:
        print('usage: build_football_extra.py <csv...> [--out out.json]'); sys.exit(1)

    matches = []
    for p in args:
        matches.extend(load_rows(p))
    matches.sort(key=lambda m: m['dt'])

    elo = {}          # clé normalisée -> rating
    gp = {}           # clé -> nb matchs
    league = {}       # clé -> nom de ligue (dernier vu)
    for m in matches:
        h, a = norm(m['home']), norm(m['away'])
        if len(h) < 2 or len(a) < 2:
            continue
        rh = elo.get(h, START)
        ra = elo.get(a, START)
        eh = 1.0 / (1.0 + 10 ** (-((rh + HFA) - ra) / 400.0))
        if m['hg'] > m['ag']:
            sh = 1.0
        elif m['hg'] < m['ag']:
            sh = 0.0
        else:
            sh = 0.5
        elo[h] = rh + K * (sh - eh)
        elo[a] = ra + K * ((1.0 - sh) - (1.0 - eh))
        gp[h] = gp.get(h, 0) + 1
        gp[a] = gp.get(a, 0) + 1
        if m['league']:
            league[h] = m['league']
            league[a] = m['league']

    teams = {}
    for k, r in elo.items():
        if gp.get(k, 0) < MIN_MATCHES:
            continue
        teams[k] = {'elo': round(r, 1), 'league': league.get(k, ''), 'gp': gp[k]}

    if len(teams) < 30:
        print(f'ABORT: seulement {len(teams)} équipes (>=10 matchs) — trop peu, on n\'écrit pas.')
        sys.exit(2)
    bad = [k for k, v in teams.items() if not (1200 <= v['elo'] <= 1800)]
    if bad:
        print(f'ABORT: {len(bad)} équipes hors bornes Elo 1200-1800, ex. {bad[:3]}')
        sys.exit(2)

    data = {
        'updated': datetime.date.today().isoformat(),
        'source_short': 'football-data',
        'hfa': int(HFA),
        'teams': dict(sorted(teams.items(), key=lambda kv: -kv[1]['elo'])),
        'aliases': {},
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump(data, open(out_path, 'w'), ensure_ascii=False, indent=2)
    print(f'OK {len(teams)} équipes · {len(matches)} matchs rejoués → {out_path}')


if __name__ == '__main__':
    main()
