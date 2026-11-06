# TEST-01 — Socle de tests applicatifs

## Choix et organisation

- TypeScript strict et Node.js **24**, conformément à ADR-0001.
- Vitest pour backend (`node`) et frontend (`jsdom`), sans imposer un framework UI.
- Un workspace npm dans `app/` : `shared`, `functions/*`, `frontend`.
- Les SDK Google utilisés pour tester les émulateurs sont des dépendances de
  développement du socle. Chaque service déclarera ses dépendances de production.
- Le code Discord non suivi préexistant n'est pas modifié par ce ticket.

Les tests initiaux valident le socle, pas les futures fonctionnalités : protection
contre un projet réel, disponibilité du DOM, transaction Firestore, publication
et réception Pub/Sub. Le test Pub/Sub utilise le pull pour vérifier l'émulateur,
**pas pour choisir le mode de consommation de production** : les workers utiliseront
le push OIDC prévu par ADR-0002. L'authentification IAM/OIDC n'est pas reproduite
par ces tests locaux.

## Prérequis locaux

- Node.js 24 et npm (le lockfile est versionné).
- Java 21 pour les émulateurs Firebase.
- Ports locaux libres : Firestore 8085, Pub/Sub 8086 et ports auxiliaires Firebase.
- Accès réseau au premier lancement pour télécharger les outils et émulateurs.

Depuis `app/` :

```sh
npm ci
npm run typecheck
npm test
npm run test:coverage
npm run test:integration
```

`npm run test:watch` relance les tests unitaires à chaque modification.
`npm run emulators` lance les émulateurs pour le diagnostic manuel ; l'arrêter
avant `test:integration`, qui gère lui-même leur démarrage et leur arrêt.

Pour le diagnostic d'une suite avec des émulateurs déjà démarrés :

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 \
PUBSUB_EMULATOR_HOST=127.0.0.1:8086 \
GCLOUD_PROJECT=demo-pixelwar-test \
npx vitest run --config vitest.integration.config.ts
```

Aucune connexion Firebase ni clé cloud n'est nécessaire pour ces tests. Le projet
fictif `demo-pixelwar-test` et les endpoints loopback sont contrôlés avant la
construction des clients SDK pour éviter de cibler GCP. Chaque test utilise des
IDs uniques et nettoie ses ressources. Les règles Firestore locales refusent les
accès clients : les SDK serveur d'intégration passent par l'accès administrateur
de l'émulateur. Ce fichier n'est pas une implémentation des règles de production
et ne doit pas être déployé avec `firebase deploy`.

## Ajouter des tests

- Backend : `shared/**/*.test.ts`, `functions/**/*.test.ts`.
- Frontend : `frontend/**/*.test.ts` ; jsdom fournit le DOM, **pas** un navigateur
  réel, ni un moteur de rendu Canvas/WebGL complet. Des tests navigateur viendront
  avec le canvas.
- Intégration : `*.integration.test.ts`, avec setup de sécurité automatique.
- Nommer les sources applicatives sous `src/` pour qu'elles soient incluses dans
  la couverture ; les tests peuvent être colocalisés ou dans un répertoire `tests`.
- Un nouveau service utilise un `package.json` dans `functions/<service>/` pour
  rejoindre le workspace. Ne pas committer `node_modules`.

## Couverture et échec bloquant

Le seuil initial est **70 % par fichier** pour lignes, instructions, fonctions
et branches sur :

- `functions/*/src/**/*.ts` (proxies et workers) ;
- `shared/src/**/*.ts` ;
- `frontend/src/**/*.ts` ;
- le garde-fou d'environnement des tests.

Les fichiers sources non importés par un test sont inclus dans le calcul. Il ne
faut pas masquer du code non testé avec des exclusions. Les tests et déclarations
TypeScript ne sont pas comptés comme du code de production.
Il n'y a encore ni proxy ni worker implémenté : le taux initial couvre le garde-fou
de test, pas une application métier terminée.

Rapports : `app/coverage/index.html`, `coverage-summary.json`, `lcov.info` et
`app/test-results/*.xml` (JUnit). Les tests d'intégration sont séparés et ne servent
pas à gonfler la couverture unitaire.

Sur **chaque PR vers prod**, le job `application` exécute installation, typecheck,
tests unitaires avec seuil puis tests d'intégration. Les rapports sont attachés
au run comme artefacts et la couverture est publiée dans le résumé GitHub Actions
(pas de commentaire nécessitant un token en écriture sur la PR).
Le job `CI result`, exigé par la protection de branche, dépend aussi de ce job :
test cassé ou seuil insuffisant fait échouer la CI. Les contournements administrateur
restent régis par les règles GitHub, pas par ce code.

Les tests tournent initialement sur runner GitHub-hosted, le temps de fournir Node
24 et Java 21 dans l'image self-hosted. Aucun worker métier n'est déployé sur GKE.
Les workflows n'utilisent ni WIF ni permissions GCP pour ces émulateurs.

## Dépendances : point d'attention initial

`npm audit` signale des vulnérabilités **modérées** dans des dépendances transitives
du CLI de développement `firebase-tools` : OpenTelemetry Core (propagation baggage)
et uuid via gaxios. Elles ne sont pas des dépendances de production des futurs
services à ce stade. Le CLI est utilisé ici avec des émulateurs locaux et un projet
fictif ; cela ne signifie pas que les alertes sont corrigées ou inexploitables.
Réévaluer lors de SEC-02 et des mises à jour du CLI. Ne pas appliquer
`npm audit fix --force` sans revue des changements majeurs proposés.

## Critères de validation

- Vérifier localement et dans la PR les suites unitaires et intégration.
- Vérifier la publication des rapports de couverture et JUnit.
- Vérifier qu'un test volontairement cassé fait échouer `CI result` avant de
  rétablir le test ; ne pas merger la version cassée.
- Vérifier le refus d'une source applicative non couverte sous le seuil.
- Les tests métier des proxies/workers seront ajoutés avec leurs tickets ; ce
  socle n'affirme pas encore que le pipeline métier est validé.
