#!/usr/bin/env python3
"""Génère data/club-elo.json depuis le CSV de clubelo.com.

Usage : python3 scripts/build_club_elo.py <clubelo.csv> [sortie.json]
CSV attendu (http://api.clubelo.com/AAAA-MM-JJ) :
    Rank,Club,Country,Level,Elo,From,To
"""
import sys, csv, json, re, unicodedata, os, datetime


def norm(s):
    s = unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', ' ', s)).strip()


def main():
    if len(sys.argv) < 2:
        print('usage: build_club_elo.py <clubelo.csv> [out.json]'); sys.exit(1)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, 'data', 'club-elo.json')

    text = open(sys.argv[1], encoding='utf-8').read()
    start = text.find('Rank,Club,Country')
    if start < 0:
        print('ABORT: en-tête CSV introuvable'); sys.exit(2)
    rows = list(csv.DictReader(text[start:].splitlines()))
    clubs = {}
    for r in rows:
        try:
            elo = float(r['Elo'])
        except (TypeError, ValueError, KeyError):
            continue
        name = (r.get('Club') or '').strip()
        if not name:
            continue
        clubs[norm(name)] = {
            'e': round(elo),
            'c': (r.get('Country') or '').strip(),
            'l': int(r['Level']) if str(r.get('Level', '')).isdigit() else None,
            'n': name
        }
    if len(clubs) < 100:
        print(f'ABORT: seulement {len(clubs)} clubs — format modifié ?'); sys.exit(2)

    data = {
        'updated': datetime.date.today().isoformat(),
        'source': 'clubelo.com — Elo des clubs européens',
        'method': "Elo mis à jour après chaque match, toutes divisions européennes. 1500 = moyenne. Probabilité = 1/(1+10^((Eb-Ea)/400)), avec avantage du terrain.",
        'count': len(clubs),
        'clubs': clubs
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(data, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(f'OK {len(clubs)} clubs → {out} ({os.path.getsize(out)} octets)')


if __name__ == '__main__':
    main()
