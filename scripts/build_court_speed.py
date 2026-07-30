#!/usr/bin/env python3
"""Régénère data/court-speed.json depuis la page ATP Surface Speed Ratings.

Usage : python3 scripts/build_court_speed.py <page_atp.txt> [sortie.json]

<page_atp.txt> : rendu de https://tennisabstract.com/reports/atp_surface_speed.html
récupéré via web_fetch (qui sauvegarde la page sur disque).

Les alias existants (noms sponsorisés, variantes FR/EN) sont PRÉSERVÉS.
Si un tournoi apparaît plusieurs fois (fenêtre 52 semaines), la ligne la plus
récente gagne.
"""
import sys, re, json, unicodedata, os


def norm(s):
    s = unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', ' ', s)).strip()


# Libellés Tennis Abstract → clés françaises déjà utilisées par l'app
RENAME = {
    'athens': 'athenes', 'brussels': 'bruxelles', 'mallorca': 'majorque', 'vienna': 'vienne',
    'cincinnati masters': 'cincinnati', 'miami masters': 'miami',
    'indian wells masters': 'indian wells', 'australian open': 'open d australie',
    'shanghai masters': 'shanghai', 'beijing': 'pekin', 'paris masters': 'paris bercy',
    'madrid masters': 'madrid', 'rome masters': 'rome', 'monte carlo masters': 'monte carlo',
    'canada masters': 'canada', 'hamburg': 'hambourg', 'barcelona': 'barcelone',
    'bucharest': 'bucarest', 'geneva': 'geneve', 'queen s club': 'queen s club',
}

ROW = re.compile(r'\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*\[([^\]]+)\]\([^)]*\)\s*\|\s*(\w+)\s*\|\s*[\d.]+%\s*\|\s*([\d.]+)\s*\|')


def main():
    if len(sys.argv) < 2:
        print('usage: build_court_speed.py <page_atp.txt> [out.json]'); sys.exit(1)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, 'data', 'court-speed.json')

    text = open(sys.argv[1], encoding='utf-8').read()
    rows = ROW.findall(text)
    if len(rows) < 20:
        print(f'ABORT: seulement {len(rows)} tournois trouvés — format de page modifié ?'); sys.exit(2)

    best = {}   # clé → (date, speed, surface)
    for date, name, surface, speed in rows:
        key = RENAME.get(norm(name), norm(name))
        if key not in best or date > best[key][0]:
            best[key] = (date, float(speed), surface)

    # Conserver les alias et métadonnées existants
    prev = {}
    if os.path.exists(out_path):
        try: prev = json.load(open(out_path, encoding='utf-8'))
        except Exception: prev = {}

    updated = max(d for d, _, _ in best.values())
    data = {
        'updated': updated,
        'source': 'Tennis Abstract — ATP Surface Speed Ratings (52 dernières semaines)',
        'method': prev.get('method', "Indice basé sur le taux d'aces ajusté des serveurs et relanceurs. 1.00 = moyenne du circuit."),
        'tour': 'atp',
        'note': prev.get('note', "Aucune table WTA publiée : l'indice ATP d'un même site est une approximation indicative."),
        'courts': {k: {'s': round(v[1], 2), 'surface': v[2]}
                   for k, v in sorted(best.items(), key=lambda kv: -kv[1][1])},
        'aliases': prev.get('aliases', {})
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump(data, open(out_path, 'w'), ensure_ascii=False, indent=2)
    print(f'OK {len(data["courts"])} tournois · maj {updated} → {out_path}')


if __name__ == '__main__':
    main()
