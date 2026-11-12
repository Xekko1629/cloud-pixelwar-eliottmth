# Tests applicatifs

## Choix et organisation

- TypeScript strict et Node.js **24**, conformément à ADR-0008.
- Vitest pour backend (`node`) et frontend (`jsdom`), sans imposer un framework UI.
- Un workspace npm dans `app/` : `shared`, `functions/*`, `frontend`.
- Les SDK Google utilisés pour les émulateurs sont des dépendances de
  développement. Chaque fonction déclare ses dépendances d'exécution dans son
  manifeste, selon le [contrat de construction](functions.md).

Les tests d'émulateurs couvrent l'isolation du projet de test, les transactions
Firestore et la publication/réception Pub/Sub. Le test Pub/Sub utilise le pull
pour vérifier l'émulateur, **pas pour définir le mode de consommation en
production** : le contrat des workers est le push OIDC (ADR-0002).
L'authentification IAM/OIDC n'est pas reproduite
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
- Outils : `tools/**/*.test.ts`, dont l'enregistrement Discord simulé.
- Frontend : `frontend/**/*.test.ts` ; jsdom fournit le DOM, **pas** un navigateur
  réel ni un moteur de rendu Canvas/WebGL complet. Vérifier le rendu et les
  interactions visuelles avec un navigateur en complément.
- Intégration : `*.integration.test.ts`, avec setup de sécurité automatique.
- Nommer les sources applicatives sous `src/` pour qu'elles soient incluses dans
  la couverture ; les tests peuvent être colocalisés ou dans un répertoire `tests`.
- Une nouvelle fonction utilise un `package.json` dans `functions/<nom>/` pour
  rejoindre le workspace, avec le contrat décrit dans [functions.md](functions.md).
  Ne pas committer `node_modules`.

## Couverture et échec bloquant

Le seuil configuré est **70 % par fichier** pour lignes, instructions, fonctions
et branches sur :

- `functions/*/src/**/*.ts` (proxies et workers) ;
- `tools/*/src/**/*.ts` (outils de déploiement) ;
- `shared/src/**/*.ts` ;
- `frontend/src/**/*.ts` ;
- le garde-fou d'environnement des tests.

Les fichiers sources non importés par un test sont inclus dans le calcul. Il ne
faut pas masquer du code non testé avec des exclusions. Les tests et déclarations
TypeScript ne sont pas comptés comme du code de production.

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

Le job applicatif utilise un runner hébergé GitHub avec Node 24 et Java 21.
Les runners GKE exécutent des jobs CI, pas les fonctions applicatives.
Les workflows n'utilisent ni WIF ni permissions GCP pour ces émulateurs.

## Vérifier les dépendances

Depuis `app/`, exécuter `npm audit` et examiner chaque chaîne de dépendances,
son usage et son exposition. Pour une fonction, analyser également le manifeste
de son bundle et les dépendances installées dans un répertoire isolé : l'audit
de l'outillage de développement ne remplace pas celui du runtime.

Conserver le résultat daté dans les rapports CI ou une issue de sécurité, pas
comme un inventaire permanent dans ce guide. Ne pas appliquer
`npm audit fix --force` sans revue des changements majeurs et des tests associés.

## Critères de validation

- Vérifier localement et dans la PR les suites unitaires et intégration.
- Vérifier la publication des rapports de couverture et JUnit.
- Vérifier qu'un test volontairement cassé fait échouer `CI result` avant de
  rétablir le test ; ne pas merger la version cassée.
- Vérifier le refus d'une source applicative non couverte sous le seuil.
- Pour les intégrations cloud, vérifier séparément IAM/OIDC, quotas, déclencheurs,
  règles de sécurité et latences : les émulateurs n'en constituent pas une preuve.
