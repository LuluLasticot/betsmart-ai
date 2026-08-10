# BetSmart AI

Application web privée de **gestion de bankroll de paris sportifs**, assistée par IA.
PWA en JavaScript natif (aucun build), déployée sur Vercel, données locales (IndexedDB) synchronisées via Firebase.

> ⚠️ Projet personnel. Aucune IA ne prédit le sport de façon fiable : les suggestions sont des analyses probabilistes, pas des certitudes. Ne misez que ce que vous pouvez perdre. Besoin d'aide : [joueurs-info-service.fr](https://www.joueurs-info-service.fr) · 09 74 75 13 13.

## Fonctionnalités

| Vue | Rôle |
|---|---|
| **Dashboard** | Bankroll, KPI, évolution, paris en direct |
| **Mes paris** | Saisie manuelle ou par scan de ticket (Vision), filtres, règlement |
| **Analyse** | ROI par sport/compétition/bookmaker/période, drawdown, calibration, **CLV** |
| **Coach IA** | Détection de biais comportementaux (tilt, sur-mise) |
| **Radar IA** | Détection de value bets : analyse à l'aveugle + confrontation aux cotes réelles |

Support **multi-devises** : euro ou cryptomonnaies (BTC, ETH, SOL, USDT…) avec conversion en euros à titre indicatif.

## Le Radar en deux phases

Le point clé de la conception : **l'IA ne voit jamais les cotes**.

1. **Phase A — analyse à l'aveugle.** Le modèle reçoit les rencontres et les issues, sans aucun prix. Il produit pour chaque issue une **fourchette de probabilité** (basse / médiane / haute) et une **qualité de dossier** (A à D).
2. **Phase B — confrontation, côté application.** L'app calcule l'edge sur la **borne basse** (estimation conservatrice), le mélange à la ligne dévigorisée du marché, applique Kelly fractionné plafonné et classe les picks.

Conséquence : une conviction mal étayée produit une fourchette large, donc une borne basse faible, donc aucun pick. Les dossiers C et D sont rejetés d'office. **Le « no bet » est une conclusion valide.**

### Ancrages statistiques (données, pas intuitions)

| Sport | Modèle | Source |
|---|---|---|
| Football | Poisson–Dixon-Coles (buts attendus, 1N2, O/U, BTTS) | forme réelle via api-sports |
| Football | Elo des clubs (toutes divisions européennes) | [clubelo.com](http://clubelo.com) |
| Tennis | Elo par surface (dur / terre / gazon) | [Tennis Abstract](https://tennisabstract.com) |
| Tennis | Indice de **vitesse des courts** par tournoi | Tennis Abstract |

Ces tables sont servies en **fichiers statiques** (`data/*.json`), régénérées chaque semaine par une tâche planifiée (`scripts/build_*.py`). Aucun appel réseau externe à l'exécution.

### Boussole : la CLV

La **Closing Line Value** (cote prise vs cote de clôture) est mesurée automatiquement à chaque coup d'envoi. Elle pilote le Radar : une CLV moyenne négative durcit ses critères de sélection. C'est le meilleur indicateur d'un avantage réel — avant même les résultats.

## Architecture

```
index.html          Vue unique, navigation côté client
css/style.css       Design system (dark, sans framework)
js/
  app.js            Orchestration, UI, état
  db.js             IndexedDB (paris, transactions, picks, réglages)
  cloud.js          Firebase Auth + Firestore (isolation stricte par compte)
  advisor.js        Radar : prompts, appels Gemini, Kelly
  gemini.js         Client Gemini : découverte auto du modèle, quota, vision
  poisson.js        Modèle de buts (football)
  clubelo.js        Elo des clubs (football)
  tennis.js         Elo tennis + vitesse des courts
  anchor.js         Ancrage quantitatif par sport + garde-fou du Radar
  facts.js          Faits réels via api-sports (forme, xG, blessures, compos)
  scores.js         Scores en direct — sans IA (coteur + api-sports)
  coteur.js         Cotes réelles des bookmakers français
  money.js          Devises (euro + crypto), conversion, formatage
  analytics.js      Agrégats de la vue Analyse
api/                Fonctions serverless Vercel (proxys)
data/               Tables statiques régénérées chaque semaine
scripts/            Générateurs de ces tables
```

**Coût maîtrisé** : les tâches mécaniques (scores, résultats) n'utilisent pas de LLM ; les appels Gemini limitent la « réflexion » et plafonnent la sortie, poste de dépense dominant.

## Installation

```bash
git clone <ce-repo> && cd betsmart-ai
npx serve .          # ou tout serveur statique
```

Aucune dépendance, aucun build. Pour le déploiement : Vercel (les fonctions `api/` sont détectées automatiquement).

### Configuration

| Réglage | Où | Nécessaire pour |
|---|---|---|
| Clé **Gemini** | Réglages de l'app | Radar, Coach, scan de tickets |
| Clé **api-sports** | Réglages de l'app | Forme, xG, blessures, compositions |
| Clé **The Odds API** | Réglages de l'app | Cotes (optionnel, coteur suffit) |
| Config **Firebase** | `js/firebase-config.js` | Synchronisation multi-appareils (optionnelle) |
| `CRON_SECRET` | Variable d'env. Vercel | Protège l'endpoint de snapshot des cotes |

Les clés d'API utilisateur sont saisies dans l'application et stockées **localement** (IndexedDB) — elles ne sont jamais dans le code.

## Sécurité

Voir [`SECURITY.md`](SECURITY.md) avant de rendre ce dépôt public.

## Licence

Usage personnel. Les données tierces (Tennis Abstract, Club Elo, coteur.com) restent la propriété de leurs auteurs et sont soumises à leurs conditions d'utilisation.
