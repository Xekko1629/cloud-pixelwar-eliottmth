# Temps réel du navigateur (DRAW-03a)

La toile se met à jour sans rafraîchir ni interroger en boucle (sujet §3.4, C07 §3.3).
Le navigateur ouvre deux listeners Firestore avec la librairie cliente, en lecture
seule ([ADR-0015](adr/0015-temps-reel-listeners-firestore-navigateur.md)). Toutes les
écritures et les lectures sensibles (auteurs, quota) restent derrière API Gateway.

## Ce que le navigateur peut lire

Les Security Rules (`infra/serverless/firestore.rules`) n'autorisent que :

| Chemin | Accès | Contenu |
| --- | --- | --- |
| `deltas/{id}` | lecture et requêtes | pixels changés d'une transaction et d'une région, **sans auteur** |
| `config/global` | lecture du document | pause, taille, bornes, `canvas_version` |

Tout le reste est refusé : `tile_colors`, `tile_metadata` (auteurs), `users`,
`ratelimit_overrides`, `processed_events`, `admin_events`, les autres documents de
`config`, et **toute écriture**, y compris sur les deux chemins lisibles. Les règles ne
dépendent d'aucune identité : le navigateur n'utilise pas Firebase Auth, et un
contexte connecté n'obtient rien de plus.

Les fonctions ne sont pas concernées : elles passent par IAM avec leur compte de service.

## Configuration

- `infra/serverless/realtime.tf` publie les règles et crée la clé d'API passée au
  SDK, limitée à l'API Firestore et aux pages du frontend. La clé ne protège pas les données : Firestore n'exige aucune clé pour une requête
  sans identité (vérifié en dev le 26/11/2026 : lecture de `config/global` acceptée
  sans clé ou avec un autre referrer, lecture de `users` refusée dans tous les cas).
  Seules les Security Rules décident. La restriction limite seulement l'usage de
  cette clé : elle ne peut servir qu'à l'API Firestore, depuis les pages du frontend.
- Aucun produit Firebase n'est nécessaire : le SDK ouvre les listeners sur le projet
  GCP seul (vérifié en dev le 26/11/2026).
- `infra/frontend` lit la clé dans le state `serverless` et l'écrit dans
  `/config.js` (`firestoreProjectId`, `firestoreApiKey`). La CSP autorise déjà
  `https://firestore.googleapis.com`.
- Seuls `firebase/app` et `firebase/firestore` sont embarqués, dans un fichier chargé
  à la demande (`src/realtime/firestore.ts`) : la page s'affiche avant le SDK.

## Comportement du frontend

`app/frontend/src/realtime/` :

- **`config/global`** : le bandeau affiche l'état du temps réel et « Toile en pause ».
  Quand `canvas_version` change (`/admin clear`), les tuiles modifiées sont oubliées
  et la toile est redessinée.
- **Deltas** : requête `canvas_version == v`, `region in [régions visibles]` (30 au
  plus), `created_at > ouverture − 30 s`. Les 30 s absorbent l'écart entre l'horloge
  du navigateur et celle du serveur ; un delta reçu deux fois repeint les mêmes
  couleurs dans le même ordre. Au-delà de 30 régions, le listener suit toutes les
  régions de la version (vue éloignée, WEB-03d). Les champs et leur ordre suivent
  les index composites `deltas_by_region` et `deltas_global`.
- Le listener est recréé quand l'ensemble des régions visibles change, 250 ms après
  la fin du déplacement, ou quand la version change. Un snapshot tardif d'un listener
  remplacé est ignoré.
- Chaque delta ne redessine que les tuiles qu'il touche.

Les deltas sont peints sur les tuiles chargées par `tile-reader` (WEB-03b, voir le
[README du frontend](../app/frontend/README.md#tuiles-web-03b)). Les pixels reçus pendant
le chargement d'une région sont repeints sur la réponse, qui peut être plus ancienne.
Sans session, la toile est masquée : elle ne montrerait que les deltas, pas l'état à jour. WEB-03c ignorera
un delta plus ancien que la tuile chargée.

## Tests

| Niveau | Fichier | Ce qui est vérifié |
| --- | --- | --- |
| Règles, émulateur | `app/testing/firestore-rules.integration.test.ts` | lectures autorisées, lectures refusées, toute écriture refusée, avec et sans identité |
| Terraform | `infra/serverless/tests/realtime.tftest.hcl` | règles publiées depuis le fichier testé, usage de la clé limité à Firestore et au frontend, rien sans `enable_realtime` |
| Terraform | `infra/frontend/tests/frontend.tftest.hcl` | clé lue dans le state `serverless`, format vérifié |
| Unitaires | `app/frontend/src/realtime/*.test.ts`, `canvas/live-tiles.test.ts` | lecture des documents, régions visibles, recréation du listener, `/admin clear` |

Les tests des règles chargent eux-mêmes `firestore.rules` dans l'émulateur
(`firebase.json` ne déclare pas de règles : le CLI refuse un fichier hors de `app/`).

## Déploiement

1. `infra/iam` (à la main, dans chaque environnement) : APIs `firebaserules.googleapis.com`
   et `apikeys.googleapis.com`, rôles `roles/firebaserules.admin` et
   `roles/serviceusage.apiKeysAdmin` du deployer, `roles/firebaserules.viewer` et
   `roles/serviceusage.apiKeysViewer` du planner.
2. `enable_realtime = true` dans les tfvars du stack `serverless` (dev aujourd'hui).
3. Déploiement par la CI : `serverless` publie les règles et la clé, puis `frontend`
   redémarre avec la clé dans `/config.js`.

Vérification : ouvrir le frontend, le bandeau indique « Temps réel : connecté » ;
un `/draw` depuis Discord apparaît sans rafraîchir.

Développement local : `FIRESTORE_PROJECT_ID=cloud-pixelwar-dev FIRESTORE_API_KEY=<output
firestore_web_api_key> npx vite` (la clé de dev accepte `http://localhost:5173`).
