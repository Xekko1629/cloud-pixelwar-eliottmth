# ADR-0011 · Frontend : application React servie par une image Docker sur Cloud Run

- **Statut** : Accepté (demandé à la revue intermédiaire)
- **Date** : 2026-11-19
- **Tickets** : WEB-01 (#65), SEC-01 (#83), SEC-02 (#84). Remplace [ADR-0006](0006-hebergement-frontend-firebase-hosting.md).
- **Références** : Sujet §3.4, §2.2 · [Cloud Run : accès public](https://cloud.google.com/run/docs/authenticating/public) · [Artifact Registry](https://cloud.google.com/artifact-registry/docs/docker/pushing-and-pulling)

## Contexte

- La revue intermédiaire demande de ne plus utiliser Firebase, et de construire le
  frontend React dans une image Docker déployée sur Cloud Run.
- L'ADR-0006 retenait Firebase Hosting et écartait Cloud Run parce que le service
  devait être public (`allUsers`).
- Le frontend est une application statique : il ne contient aucun secret, et sa
  configuration (URL de la gateway, URL du flux temps réel, client id Discord) est
  publique par nature.

## Décision

### Image

- Application **React + TypeScript**, construite par **Vite** dans le workspace
  `app/frontend`, qui réutilise `@pixelwar/shared` (palette, tuiles, codec des deltas).
- `app/frontend/Dockerfile` multi-étapes :
  1. étape `build` : `node:24` avec `npm ci` sur le lockfile du workspace, puis `vite build` ;
  2. étape finale : `nginxinc/nginx-unprivileged` (utilisateur non root, port 8080),
     qui ne contient que `dist/` et la configuration nginx.
- Images de base épinglées par digest (SEC-02).
- nginx sert l'application monopage (repli de toutes les routes vers `index.html`,
  dont `/auth/callback`), pose les en-têtes de sécurité (`Content-Security-Policy`
  limitée à la gateway, au flux temps réel et à Discord, `Strict-Transport-Security`,
  `X-Content-Type-Options`) et gère le cache (longue durée pour les fichiers
  hachés, aucun cache pour `index.html` et `config.js`).

### Configuration par environnement

- La même image est déployée en dev puis en prd : la configuration n'est pas
  compilée dans le bundle.
- Au démarrage du conteneur, un script génère `/config.js` à partir des variables
  d'environnement du service Cloud Run (`GATEWAY_URL`, `REALTIME_URL`,
  `DISCORD_CLIENT_ID`). `index.html` le charge avant le bundle.

### Build et déploiement

- La CI construit l'image **une fois par commit**, la pousse dans le dépôt
  Artifact Registry `pixelwar` (créé par le bootstrap) avec le tag du commit, et
  transmet son **digest** à Terraform.
- Le build se fait sur un runner GitHub hébergé (`docker buildx`), authentifié
  par Workload Identity : les runners ARC n'ont pas de démon Docker.
- `infra/serverless` déclare un `google_cloud_run_v2_service` `frontend` qui
  référence l'image **par digest**, jamais par tag.
- `min_instance_count = 0`, `max_instance_count` plafonné (2 en dev, 4 en prd).

### Identité et accès

- Le service a son propre compte de service `frontend`, **sans aucun rôle** : il
  ne lit ni Firestore, ni Secret Manager, ni aucun bucket.
- Le service est public : `roles/run.invoker` pour `allUsers`. C'est la seule
  exception à la règle « aucun service public » ; SEC-01 la liste explicitement
  et échoue sur tout autre binding `allUsers`.
- Toutes les API restent derrière API Gateway. Le frontend n'est pas un proxy :
  nginx ne relaie aucun appel vers un backend.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Firebase Hosting (ADR-0006) | Firebase est exclu par la revue intermédiaire. |
| Cloud Run privé derrière API Gateway (route `/{path=**}`) | Aucune exposition directe, mais chaque fichier statique devient un appel d'API facturé et soumis au délai de la gateway, sans cache CDN. À reconsidérer seulement si l'encadrant refuse l'exception `allUsers`. |
| Bucket Cloud Storage public + Load Balancer + Cloud CDN | Bucket lisible par `allUsers`, contraire à C06 §4.1 ; règle de transfert facturée au repos ; certificat géré impossible sans nom de domaine. |
| Bundle compilé par environnement | Deux images différentes pour dev et prd : la release ne serait plus un artefact unique. |

## Conséquences

- Un pipeline d'image à maintenir : Dockerfile, build, push et digest transmis à
  Terraform, avec les versions des images de base suivies par SEC-02.
- Cold start possible sur la page d'accueil quand le service est à zéro instance.
- Pas de CDN devant le service : les fichiers hachés sont mis en cache par le
  navigateur. Suffisant pour la démonstration.
- Le dépôt Artifact Registry conserve les images : une politique de nettoyage
  garde les N dernières et celles référencées par l'environnement déployé.
- La redirect URI Discord de chaque environnement devient l'URL `run.app` du
  service (`https://frontend-…run.app/auth/callback`), enregistrée dans
  l'application Discord de cet environnement (BOT-01).
