# Tables d'ancrage — régénération hebdomadaire

Le Radar s'appuie sur des tables statiques plutôt que sur api-sports, dont le
palier gratuit est limité à **100 requêtes par jour et par sport** — insuffisant
pour alimenter un scan de 30 candidats. Ces tables sont servies en même origine
et rafraîchies une fois par semaine par la tâche planifiée.

| Fichier | Source | Sport | Saisonnalité |
|---|---|---|---|
| `data/tennis-elo.json` | Tennis Abstract | Tennis | toute l'année |
| `data/court-speed.json` | Tennis Abstract (Surface Speed) | Tennis | toute l'année |
| `data/club-elo.json` | api.clubelo.com | Football | août → mai |
| `data/basket-ratings.json` | Basketball-Reference | Basket | octobre → juin |
| `data/mlb-ratings.json` | MLB StatsAPI | Baseball | avril → octobre |

## Sources et points d'entrée

- **Basket** : `https://www.basketball-reference.com/leagues/NBA_<année>_ratings.html`
  Colonnes utiles : `MOV/A`, `ORtg/A`, `DRtg/A` (ajustées de la force du calendrier).
  L'année est celle de FIN de saison (saison 2026-27 → `NBA_2027_ratings.html`).

- **Baseball** : `https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=<année>&standingsTypes=regularSeason&fields=records,teamRecords,team,id,name,wins,losses,runsScored,runsAllowed,gamesPlayed`
  Gratuit, sans clé. Le paramètre `fields` limite fortement le volume de réponse.

## Contrainte d'infrastructure

Le bac à sable n'a pas d'accès réseau vers ces hôtes : la récupération passe
obligatoirement par l'outil de récupération web de l'assistant, qui écrit
ensuite le JSON. Les scripts de ce dossier font la **transformation**, pas le
téléchargement.

## Fraîcheur

Chaque table porte un champ `updated`. Au-delà de 3 semaines pendant la saison,
considérez l'ancrage comme périmé : les notes d'équipe dérivent vite après des
blessures ou des transferts.
