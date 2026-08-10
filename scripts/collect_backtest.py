#!/usr/bin/env python3
"""Accumule progressivement les données historiques du backtest.

football-data.co.uk publie un CSV par championnat et par saison (résultats +
cotes d'ouverture ET de clôture). L'outil de récupération tronque chaque
réponse, donc on ne récupère qu'une partie d'un fichier à la fois — mais il
existe des CENTAINES de couples championnat × saison. En en collectant
quelques-uns par semaine, l'échantillon grossit jusqu'à devenir significatif.

Ce script fusionne un CSV fraîchement récupéré dans data/backtest/, en
dédoublonnant sur (date, domicile, extérieur). Rien n'est jamais écrasé.

Usage :
    python3 scripts/collect_backtest.py <fichier_recupere.txt> [...]
    python3 scripts/collect_backtest.py --etat        # ce qui est déjà collecté
    python3 scripts/collect_backtest.py --manque 6    # prochains fichiers à récupérer
"""
import sys, os, csv, io, glob, re, argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'backtest')

# Championnats couverts par football-data.co.uk (code → libellé)
LEAGUES = {
    'E0': 'Premier League', 'E1': 'Championship', 'D1': 'Bundesliga', 'D2': 'Bundesliga 2',
    'I1': 'Serie A', 'I2': 'Serie B', 'SP1': 'LaLiga', 'SP2': 'LaLiga 2',
    'F1': 'Ligue 1', 'F2': 'Ligue 2', 'N1': 'Eredivisie', 'B1': 'Jupiler',
    'P1': 'Liga Portugal', 'T1': 'Süper Lig', 'G1': 'Super League Grèce', 'SC0': 'Premiership',
}
SEASONS = ['2526', '2425', '2324', '2223', '2122']   # 5 ans glissants
URL = 'https://www.football-data.co.uk/mmz4281/{s}/{lg}.csv'

KEY = lambda r: (r.get('Date', ''), r.get('HomeTeam', ''), r.get('AwayTeam', ''))


def parse(text):
    """Extrait les lignes exploitables d'un CSV football-data (même tronqué)."""
    i = text.find('Div,Date')
    if i < 0: return None, []
    rows = list(csv.DictReader(io.StringIO(text[i:])))
    rows = [r for r in rows if r.get('HomeTeam') and r.get('FTR') and r.get('Date')]
    if not rows: return None, []
    return rows[0].get('Div', '').strip(), rows


def season_of(rows):
    """Saison au format football-data (ex. 2425) déduite des dates."""
    years = []
    for r in rows:
        m = re.match(r'\d{2}/(\d{2})/(\d{2,4})', r['Date'])
        if m:
            mo, yr = int(m.group(1)), int(m.group(2))
            yr = yr if yr > 100 else 2000 + yr
            years.append(yr if mo >= 7 else yr - 1)   # saison à cheval
    if not years: return None
    y = max(set(years), key=years.count)
    return f"{str(y)[2:]}{str(y + 1)[2:]}"


def merge(path, rows):
    """Fusionne sans écraser ; renvoie (ajoutés, total)."""
    existing, fields = {}, None
    if os.path.exists(path):
        with open(path, encoding='utf-8-sig') as fh:
            rd = csv.DictReader(fh)
            fields = rd.fieldnames
            for r in rd: existing[KEY(r)] = r
    added = 0
    for r in rows:
        if KEY(r) not in existing:
            existing[KEY(r)] = r; added += 1
    if not fields:
        fields = list(rows[0].keys())
    else:  # colonnes nouvelles éventuelles
        for k in rows[0]:
            if k not in fields: fields.append(k)
    ordered = sorted(existing.values(), key=lambda r: (
        re.sub(r'(\d{2})/(\d{2})/(\d{2,4})', r'\3\2\1', r.get('Date', '')), r.get('HomeTeam', '')))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='') as fh:
        wr = csv.DictWriter(fh, fieldnames=fields, extrasaction='ignore')
        wr.writeheader(); wr.writerows(ordered)
    return added, len(ordered)


def etat():
    files = sorted(glob.glob(os.path.join(OUT, '*.csv')))
    total = 0
    print(f"{'fichier':<20}{'matchs':>8}")
    for p in files:
        n = sum(1 for _ in open(p, encoding='utf-8-sig')) - 1
        total += n
        print(f"  {os.path.basename(p):<18}{n:>8}")
    print(f"  {'TOTAL':<18}{total:>8} matchs dans {len(files)} fichiers")
    return {os.path.basename(p).replace('.csv', '') for p in files}, total


def manque(n):
    have, _ = etat()
    todo = [f"{lg}_{s}" for s in SEASONS for lg in LEAGUES if f"{lg}_{s}" not in have]
    print(f"\n{len(todo)} fichiers restants. Prochains {n} à récupérer :")
    for key in todo[:n]:
        lg, s = key.rsplit('_', 1)
        print(f"  {URL.format(s=s, lg=lg)}")


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='*')
    ap.add_argument('--etat', action='store_true')
    ap.add_argument('--manque', type=int, default=0)
    a = ap.parse_args()

    if a.etat: etat(); sys.exit(0)
    if a.manque: manque(a.manque); sys.exit(0)
    if not a.files: ap.print_help(); sys.exit(1)

    grand = 0
    for src in a.files:
        text = open(src, encoding='utf-8', errors='replace').read()
        div, rows = parse(text)
        if not rows:
            print(f"IGNORÉ {os.path.basename(src)} : aucune ligne exploitable"); continue
        s = season_of(rows)
        if not div or not s:
            print(f"IGNORÉ {os.path.basename(src)} : championnat/saison indéterminés"); continue
        path = os.path.join(OUT, f"{div}_{s}.csv")
        added, tot = merge(path, rows)
        grand += added
        print(f"OK {div}_{s} : +{added} nouveaux (fichier : {tot} matchs)")
    print(f"\n{grand} matchs ajoutés au total.")
