#!/usr/bin/env python3
"""Backtest du moteur de probabilités du Radar sur données historiques.

Source : CSV football-data.co.uk (résultats + cotes d'ouverture ET de clôture).

Principe — rejeu chronologique strict, SANS fuite d'information future :
pour chaque match, les modèles (Poisson sur la forme, Elo des clubs) ne voient
que les matchs DÉJÀ joués. On simule la décision du Radar au prix pré-match,
puis on mesure :
  • la CLV  = cote prise / cote de clôture − 1   (a-t-on battu le marché ?)
  • le ROI  = résultat réel à mise constante
  • la calibration : probabilité annoncée vs taux de réussite réel

Usage :
    python3 scripts/backtest.py <fichier.csv> [fichier2.csv ...] [--w 0.45] [--seuil 2]
"""
import sys, csv, math, argparse
from collections import defaultdict, deque

# ---------------------------------------------------------------- Poisson
def _pmf(k, lam):
    return math.exp(-lam) * lam ** k / math.factorial(k)

def _tau(i, j, lh, la, rho):
    if i == 0 and j == 0: return 1 - lh * la * rho
    if i == 0 and j == 1: return 1 + lh * rho
    if i == 1 and j == 0: return 1 + la * rho
    if i == 1 and j == 1: return 1 - rho
    return 1

def poisson_1x2(lh, la, rho=-0.08, mx=10):
    p1 = px = p2 = tot = 0.0
    for i in range(mx + 1):
        for j in range(mx + 1):
            p = _pmf(i, lh) * _pmf(j, la) * _tau(i, j, lh, la, rho)
            tot += p
            if i > j: p1 += p
            elif i == j: px += p
            else: p2 += p
    return p1 / tot, px / tot, p2 / tot

def poisson_from_form(hf, af, base=1.35, hfa=1.20):
    """hf/af : dict {played, gf, ga} — identique à js/poisson.js."""
    if not hf or not af or hf['played'] < 3 or af['played'] < 3: return None
    clamp = lambda x: max(0.35, min(2.6, x))
    h_att = clamp(hf['gf'] / hf['played'] / base); h_def = clamp(hf['ga'] / hf['played'] / base)
    a_att = clamp(af['gf'] / af['played'] / base); a_def = clamp(af['ga'] / af['played'] / base)
    lh = max(0.15, min(5.5, base * h_att * a_def * hfa))
    la = max(0.15, min(5.5, base * a_att * h_def))
    return poisson_1x2(lh, la)

# ---------------------------------------------------------------- Elo
def elo_1x2(eh, ea, hfa=65):
    diff = (eh + hfa) - ea
    p_hw = 1 / (1 + 10 ** (-diff / 400))          # proba hors nul
    p_draw = max(0.06, 0.29 - abs(diff) / 1600)
    rest = 1 - p_draw
    return p_hw * rest, p_draw, rest - p_hw * rest

# ---------------------------------------------------------------- outils
def devig(o1, ox, o2):
    """Probabilités justes du marché (marge retirée proportionnellement)."""
    if not (o1 and ox and o2): return None
    inv = [1 / o1, 1 / ox, 1 / o2]
    s = sum(inv)
    return [x / s for x in inv]

def f(row, key):
    try:
        v = float(row.get(key, '') or 0)
        return v if v > 1 else None
    except (TypeError, ValueError):
        return None

# ---------------------------------------------------------------- backtest
def run(paths, w_market=0.45, seuil=2.0, k_elo=20, form_n=6, verbose=True):
    rows = []
    for p in paths:
        with open(p, encoding='utf-8-sig') as fh:
            for r in csv.DictReader(fh):
                if not r.get('HomeTeam') or not r.get('FTR'): continue
                d = r.get('Date', '')
                try:
                    dd, mm, yy = d.split('/')
                    yy = ('20' + yy) if len(yy) == 2 else yy
                    r['_sort'] = f"{yy}-{mm}-{dd}"
                except ValueError:
                    continue
                rows.append(r)
    rows.sort(key=lambda r: r['_sort'])

    elo = defaultdict(lambda: 1500.0)
    form = defaultdict(lambda: deque(maxlen=form_n))   # (gf, ga)
    bets, skipped = [], 0

    for r in rows:
        h, a = r['HomeTeam'], r['AwayTeam']
        try:
            gh, ga = int(r['FTHG']), int(r['FTAG'])
        except (TypeError, ValueError):
            continue

        # ---- 1) Estimation AVANT le match (aucune donnée future)
        def agg(dq):
            if not dq: return None
            return {'played': len(dq), 'gf': sum(x[0] for x in dq), 'ga': sum(x[1] for x in dq)}
        p_poisson = poisson_from_form(agg(form[h]), agg(form[a]))
        p_elo = elo_1x2(elo[h], elo[a])

        # cotes PRÉ-match : moyenne marché (référence) et meilleure cote dispo
        avg = [f(r, 'AvgH'), f(r, 'AvgD'), f(r, 'AvgA')]
        mx = [f(r, 'MaxH'), f(r, 'MaxD'), f(r, 'MaxA')]
        fair = devig(*avg) if all(avg) else None
        # cotes de CLÔTURE : référence de CLV (Pinnacle, sinon moyenne)
        clo = [f(r, 'PSCH'), f(r, 'PSCD'), f(r, 'PSCA')]
        if not all(clo): clo = [f(r, 'AvgCH'), f(r, 'AvgCD'), f(r, 'AvgCA')]

        if p_poisson and fair and all(mx) and all(clo):
            # modèle = moyenne Poisson + Elo, puis mélange avec le marché
            model = [(p_poisson[i] + p_elo[i]) / 2 for i in range(3)]
            final = [w_market * fair[i] + (1 - w_market) * model[i] for i in range(3)]
            for i, lab in enumerate(('H', 'D', 'A')):
                price = mx[i]
                edge = final[i] * price - 1
                if edge * 100 >= seuil and 1.4 <= price <= 5.0:
                    bets.append({
                        'date': r['_sort'], 'match': f"{h} – {a}", 'sel': lab,
                        'p': final[i], 'p_model': model[i], 'p_market': fair[i],
                        'price': price, 'close': clo[i], 'edge': edge * 100,
                        'clv': (price / clo[i] - 1) * 100,
                        'won': (r['FTR'] == lab)
                    })
        else:
            skipped += 1

        # ---- 2) Mise à jour APRÈS coup (pour les matchs suivants)
        exp_h = 1 / (1 + 10 ** (-((elo[h] + 65) - elo[a]) / 400))
        res_h = 1.0 if gh > ga else 0.5 if gh == ga else 0.0
        delta = k_elo * (res_h - exp_h)
        elo[h] += delta; elo[a] -= delta
        form[h].append((gh, ga)); form[a].append((ga, gh))

    return bets, len(rows), skipped

# ---------------------------------------------------------------- rapport
def report(bets, n_matches, skipped, w, seuil):
    print(f"\n{'='*74}")
    print(f"BACKTEST — {n_matches} matchs rejoués · {skipped} ignorés (données incomplètes)")
    print(f"Réglages : poids marché {w:.0%} · seuil d'edge +{seuil}%")
    print('='*74)
    if not bets:
        print("Aucun pari généré : le seuil est trop exigeant pour cet échantillon.")
        return
    n = len(bets)
    roi = sum((b['price'] - 1) if b['won'] else -1 for b in bets) / n * 100
    clv = sum(b['clv'] for b in bets) / n
    clv_pos = sum(1 for b in bets if b['clv'] > 0) / n * 100
    hit = sum(1 for b in bets if b['won']) / n * 100
    pred = sum(b['p'] for b in bets) / n * 100
    print(f"\nPARIS GÉNÉRÉS : {n}  ({n / n_matches * 100:.1f} % des matchs)")
    print(f"  ROI (mise constante) : {roi:+.1f} %")
    print(f"  CLV moyenne          : {clv:+.2f} %   ({clv_pos:.0f} % des paris battent la clôture)")
    print(f"  Réussite réelle      : {hit:.1f} %   vs {pred:.1f} % annoncés  → écart {pred - hit:+.1f} pts")

    print(f"\n  Par tranche d'edge :")
    print(f"  {'tranche':<12}{'n':>5}{'ROI':>9}{'CLV':>9}{'CLV+':>7}{'réel':>8}{'prédit':>9}")
    buckets = [(2, 5), (5, 10), (10, 20), (20, 999)]
    for lo, hi in buckets:
        sub = [b for b in bets if lo <= b['edge'] < hi]
        if not sub: continue
        r_ = sum((b['price'] - 1) if b['won'] else -1 for b in sub) / len(sub) * 100
        c_ = sum(b['clv'] for b in sub) / len(sub)
        cp = sum(1 for b in sub if b['clv'] > 0) / len(sub) * 100
        h_ = sum(1 for b in sub if b['won']) / len(sub) * 100
        p_ = sum(b['p'] for b in sub) / len(sub) * 100
        lab = f"+{lo}–{hi}%" if hi < 999 else f"+{lo}%+"
        print(f"  {lab:<12}{len(sub):>5}{r_:>+8.1f}%{c_:>+8.2f}%{cp:>6.0f}%{h_:>7.1f}%{p_:>8.1f}%")

    print(f"\n  Par sélection :")
    for lab, nom in (('H', 'Domicile'), ('D', 'Nul'), ('A', 'Extérieur')):
        sub = [b for b in bets if b['sel'] == lab]
        if not sub: continue
        r_ = sum((b['price'] - 1) if b['won'] else -1 for b in sub) / len(sub) * 100
        c_ = sum(b['clv'] for b in sub) / len(sub)
        print(f"    {nom:<10} n={len(sub):<4} ROI {r_:+6.1f} %   CLV {c_:+5.2f} %")


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('csv', nargs='+')
    ap.add_argument('--w', type=float, default=0.45, help='poids du marché dans la proba finale')
    ap.add_argument('--seuil', type=float, default=2.0, help="edge minimum en %%")
    args = ap.parse_args()
    b, n, s = run(args.csv, w_market=args.w, seuil=args.seuil)
    report(b, n, s, args.w, args.seuil)
