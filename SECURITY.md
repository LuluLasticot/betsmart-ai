# Sécurité — à lire avant de rendre le dépôt public

Audit du code réalisé le 2026-08-03. **Aucun secret critique n'est présent dans le dépôt** : les clés Gemini, api-sports et The Odds API sont saisies dans l'application et stockées localement (IndexedDB), jamais commitées.

Trois points demandent néanmoins une action ou une vigilance.

## 1. Configuration Firebase — publique par nature, mais à protéger côté serveur

`js/firebase-config.js` et `api/snapshot.js` contiennent la clé web Firebase du projet.

**Ce n'est pas une fuite** : cette clé est un identifiant public de projet, présent dans le JavaScript de toute application Firebase côté client — la sécurité ne repose pas sur son secret. Mais elle ne protège rien non plus, donc :

- **Vérifier les règles Firestore.** Chaque utilisateur ne doit accéder qu'à ses propres documents :

  ```
  match /users/{uid}/{document=**} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
  ```

  Sans cette règle, la base est lisible par n'importe qui, dépôt public ou non.
- **Restreindre la clé** dans Google Cloud Console → *Identifiants* → restrictions par référent HTTP (`betsmart-ai.vercel.app`, `localhost`).
- **Vérifier la création de comptes** : si l'inscription par email est ouverte, n'importe qui peut créer un compte (il n'aura accès qu'à ses propres données, mais il consommera votre quota Firebase).
- Envisager **Firebase App Check** pour bloquer les appels hors de l'application.

## 2. Endpoint de snapshot — protégé par variable d'environnement

`api/snapshot.js` est protégé par `CRON_SECRET`, une variable d'environnement Vercel. **Ne jamais l'écrire en dur dans le code.** Vérifier qu'elle est bien définie côté Vercel avant publication.

## 3. Scraping de coteur.com — question de conditions d'utilisation, pas de sécurité

`api/coteur.js` et `api/snapshot.js` récupèrent les cotes de coteur.com, en reproduisant le mécanisme de jeton attendu par leur API. C'est toléré pour un usage privé, mais **contraire à leurs conditions d'utilisation**.

Publier ce code, c'est publier la méthode. Conséquences possibles : blocage côté coteur (l'application cesserait de fonctionner), voire demande de retrait. Trois options :

1. Garder le dépôt **privé** (le plus simple).
2. Publier en retirant `api/coteur.js` et `api/snapshot.js` (l'app fonctionne alors avec The Odds API).
3. Publier tel quel en assumant le risque de blocage.

## Checklist avant publication

- [ ] Règles Firestore vérifiées (accès limité à `request.auth.uid`)
- [ ] Clé Firebase restreinte par référent HTTP
- [ ] `CRON_SECRET` défini côté Vercel, absent du code
- [ ] Décision prise concernant `api/coteur.js` (cf. point 3)
- [ ] `git log -p` relu à la recherche d'une clé commitée puis retirée — **l'historique Git conserve tout** ; si une clé y figure, il faut la révoquer, pas seulement la supprimer du dernier commit
- [ ] Aucune donnée personnelle de paris dans `data/` (ces fichiers ne contiennent que des tables publiques : Elo, vitesse des courts)
