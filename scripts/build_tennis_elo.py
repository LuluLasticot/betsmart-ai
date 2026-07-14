#!/usr/bin/env python3
"""Construit data/tennis-elo.json à partir des pages Elo de Tennis Abstract.

Usage :
    python3 scripts/build_tennis_elo.py <atp_page.txt> <wta_page.txt> [sortie.json]

<atp_page.txt> / <wta_page.txt> : fichiers texte contenant le HTML/rendu des pages
    https://tennisabstract.com/reports/atp_elo_ratings.html
    https://tennisabstract.com/reports/wta_elo_ratings.html
(récupérés via web_fetch, qui les sauvegarde sur disque).

Sortie par défaut : data/tennis-elo.json (relatif à la racine du repo).
"""
import sys, re, json, unicodedata, datetime, os


def norm(s):
    s = unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', ' ', s)).strip()


def parse(path, tour, players):
    line = max(open(path, encoding='utf-8').read().split('\n'), key=len)
    cells = [c.strip() for c in line.split('|')]
    cnt = 0
    for i, c in enumerate(cells):
        m = re.match(r'\[([^\]]+)\]\(http', c)
        if not m:
            continue
        name = m.group(1).strip()
        if name.lower() in ('elo', 'yelo', 'pelo', 'helo', 'celo', 'gelo'):
            continue
        try:
            elo = float(cells[i + 2])
        except (ValueError, IndexError):
            continue

        def num(j):
            try:
                return float(cells[j])
            except (ValueError, IndexError):
                return elo
        try:
            rank = int(cells[i - 1])
        except (ValueError, IndexError):
            rank = 0
        key = norm(name)
        if len(key) < 3:
            continue
        players[key] = {'e': round(elo), 'h': round(num(i + 5)), 'c': round(num(i + 7)),
                        'g': round(num(i + 9)), 'r': rank, 't': tour}
        cnt += 1
    return cnt


def main():
    if len(sys.argv) < 3:
        print('usage: build_tennis_elo.py <atp_page> <wta_page> [out.json]')
        sys.exit(1)
    atp, wta = sys.argv[1], sys.argv[2]
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(root, 'data', 'tennis-elo.json')
    players = {}
    a = parse(atp, 'atp', players)
    w = parse(wta, 'wta', players)
    if a < 50 or w < 50:
        print(f'ABORT: trop peu de joueurs (atp={a}, wta={w}) — page mal formée ?')
        sys.exit(2)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    data = {'updated': datetime.date.today().isoformat(),
            'source': 'tennisabstract.com Elo', 'count': len(players), 'players': players}
    json.dump(data, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(f'OK atp={a} wta={w} total={len(players)} bytes={os.path.getsize(out)} -> {out}')


if __name__ == '__main__':
    main()
