# Stack serverless

## Objet et dépendances

Ce stack déclare les Cloud Run functions et leurs intégrations applicatives.
Le module `function` utilise `google_cloudfunctions2_function` ; Google construit
l'image à partir de sources dans GCS. Le compute est défini par ADR-0008 et le
mécanisme de sources par ADR-0009.

| Ressource/prérequis | Responsable |
| --- | --- |
| APIs, identités de CI, state et conteneurs de secrets | `infra/iam`, manuel |
| Accès humains | `infra/access`, manuel |
| Bucket de sources, registre d'images internes et identité de build | `infra/bootstrap`, CI |
| Réseau et cluster conditionnel | `infra/foundation`, CI |
| Sources, fonctions et IAM runtime/invocation des workers | Ce stack, CI |
| Gateway, catalogue HTTP et invocation des proxies | `infra/gateway`, CI après ce stack |

Pour une installation vide, suivre le [guide de déploiement](../../docs/deployment.md)
avant le premier init GCS. Chaque environnement utilise ses propres
`<env>.tfvars`, `backends/<env>.hcl` et secrets.

## Sources et fonctions

Le [build applicatif](../../docs/functions.md) écrit les dossiers sous
`app/dist/functions`. Le module `function-source` les zippe et les téléverse sous
`functions/<nom>/<sha256>.zip`, puis fournit bucket, objet, SHA-256 et génération
GCS au [module function](modules/function/README.md).

Les environnements construisent séparément depuis le commit choisi. Il n'y a
pas de promotion par copie d'une archive unique ni de lockfile dans le bundle
livré à Cloud Build. Le lockfile du dépôt verrouille le build CI ; les dépendances
transitives du runtime sont résolues par Google à partir du manifeste généré.

Le bucket de sources est privé, versionné et conservé par le bootstrap. Le
registre reçoit les images internes, pas un artefact fourni par l'équipe.
Vérifier les politiques de rétention et de nettoyage dans `infra/bootstrap` et
les besoins de reprise avant leur modification.

## API Gateway et invocation

`gateway-backends.tf` exporte `gateway_contract`, avec les noms, URI et types des
proxies réellement instanciés. Le catalogue de routes et la Gateway sont gérés
dans le [stack Gateway](../gateway/README.md), avec un state indépendant pour
isoler son `create_before_destroy` de celui des fonctions (ADR-0010). Une route
n'est publiée que si sa clé de backend est exportée. Sans backend, le stack
Gateway ne crée pas de Gateway et son output `gateway_url` est nul.

- Proxies : `service_type="proxy"`, ingress `ALLOW_ALL`, mais invocation IAM
  obligatoire. Le module Gateway accorde `roles/run.invoker` à son identité sur
  les seuls proxies routés, pas sur les workers.
- Workers : ingress interne et identité dédiée d'invocation Pub/Sub, distincte
  du runtime. Les abonnements utilisent le push OIDC, sans `event_trigger`.
- Routes API : Firebase par défaut ; routes de connexion et Discord publiques
  à la Gateway, avec validation dans le handler concerné.
- CORS : `cors=true` ajoute un `OPTIONS` public ; le backend doit fournir les
  en-têtes de réponse CORS.

Voir le [contrat du module Gateway](modules/api-gateway/README.md). La
[sonde Discord dev](../../docs/discord-hello.md) est activée par
`enable_discord_hello`, n'est jamais instanciée en prd et publie seulement le
callback `/discord/interactions` lorsqu'elle est activée.

### Parcours `/draw` (dev)

`discord-proxy.tf`, `discord-command.tf` et `draw-path.tf` déclarent le proxy, le
`command-worker`, le `draw-worker`, le `discord-notifier`, leurs topics et leurs
abonnements push. Chaque abonnement passe par le module
[`push-subscription`](modules/push-subscription) : push OIDC avec l'invoker dédié
du worker, retry de 10 à 60 s, DLQ et abonnement d'inspection, 7 jours de rétention.
`config/global` est créé une fois dans `firestore.tf`.

- `enable_discord_pipeline=true` crée fonctions et topics, en dev seulement.
- `enable_discord_delivery=true` crée les abonnements et les droits de l'agent Pub/Sub.
- `use_discord_proxy=true` route `/discord/interactions` vers le proxy.
- Ces trois flags n'ont aucun effet en prd ; leurs valeurs par défaut sont `false`.

Revenir vers hello change seulement `use_discord_proxy` : désactiver le pipeline
ou la livraison supprimerait les abonnements et leurs messages. Voir
[le déploiement dev du parcours `/draw`](../../docs/deploy-draw-path.md).

## Authentification web (auth-proxy)

`auth-proxy.tf` déploie la fonction de connexion Discord et de session web
([README](../../app/functions/auth-proxy/README.md), ADR-0012), activée par
`enable_auth_proxy` (dev d'abord). Elle est exportée vers la gateway comme backend
`auth` : `/auth/login`, `/auth/exchange` et `/api/session/refresh`.

- Seule son identité d'exécution reçoit `roles/iam.serviceAccountTokenCreator`, sur
  le seul compte `session-signer`. Ce binding demande au deployer le droit
  `iam.serviceAccounts.setIamPolicy` sur ce compte (rôle `serviceAccountAdmin` de
  SEC-01, #136).
- Secrets `discord-application-id` et `discord-oauth-client-secret`, en versions
  numériques explicites.
- L'output `frontend_origin` donne l'URL déterministe du frontend : seule origine
  CORS, et `<frontend_origin>/auth/callback` est la redirect URI à enregistrer dans
  l'application Discord de l'environnement.

## Firestore

`firestore.tf` crée la base `(default)` en mode Native dans la région du stack,
ses index composites (flux de deltas par région et global, tuiles d'une région),
les exemptions d'indexation des champs binaires et maps (`colors`, `pixels`) et
les politiques TTL sur `expire_at` des collections `deltas` et
`processed_events`. Les documents `users/{uid}` n'expirent pas : ils portent le
quota et le dernier rejet.

- Les fonctions passent par IAM : chaque compte d'exécution reçoit
  `roles/datastore.user` (écriture) ou `roles/datastore.viewer` (lecture), jamais
  un rôle projet large. Les Security Rules ne s'appliquent pas à elles.
- Le navigateur lit le temps réel avec la librairie cliente, limité par les
  Security Rules de `firestore.rules` : lecture de `deltas/{id}` et de
  `config/global`, aucune écriture (voir « Temps réel du navigateur »).
- `destroy` supprime la base (`deletion_policy = "DELETE"`). Avec
  `firestore_deletion_protection = true`, GCP refuse la suppression et le destroy
  échoue au lieu de perdre la grille.
- Après une suppression, l'ID `(default)` n'est réutilisable qu'après environ
  5 minutes : attendre avant de réappliquer le stack.
- Le TTL supprime les documents expirés en général sous 24 h ; les requêtes
  filtrent donc toujours sur `created_at` (ADR-0003).

## Temps réel du navigateur

`realtime.tf` (DRAW-03a, [ADR-0015](../../docs/adr/0015-temps-reel-listeners-firestore-navigateur.md)),
activé par `enable_realtime` (dev aujourd'hui) :

- `firestore.rules`, publié sur la base `(default)` par `google_firebaserules_ruleset`
  et `google_firebaserules_release`. C'est le même fichier que testent les tests
  d'intégration (`app/testing/firestore-rules.integration.test.ts`) ;
- une clé d'API de navigateur, limitée à l'API Firestore et aux pages du frontend
  (`realtime_extra_referrers` ajoute `http://localhost:5173/*` en dev). Son nom
  porte un suffixe aléatoire : une clé supprimée reste réservée 30 jours, un nom
  fixe ferait échouer un `apply` après un `destroy`. Elle est publique par nature
  (servie dans `/config.js`) et passe au stack `frontend` par l'output
  `firestore_web_api_key`.

Aucun produit Firebase n'est activé (ni projet Firebase, ni application web, ni
Auth). Prérequis dans `infra/iam`, appliqué à la main : APIs `firebaserules` et
`apikeys`, rôles `firebaserules.admin` et `serviceusage.apiKeysAdmin` du deployer,
et rôles de lecture équivalents du planner. Détails : [temps réel](../../docs/realtime.md).

## Cloud Storage

`storage.tf` crée deux buckets privés, `<projet>-snapshots` et
`<projet>-overview`, avec accès uniforme (IAM seulement, pas d'ACL) et
`public_access_prevention = "enforced"`. Ils ne contiennent que des images
dérivées de Firestore : `force_destroy = true` permet au workflow `Destroy`
de les supprimer avec leurs objets, en dev comme en prd. Ils ne remplacent pas
le bucket de sources persistant d'`infra/bootstrap`.

- `snapshots` : PNG de `/snapshot` (BOT-07a), partagés par URL signée (BOT-07b).
  Une règle lifecycle supprime les objets après `snapshot_retention_days`
  (7 jours par défaut, la durée maximale d'une URL signée V4).
- `overview` : pyramide de la vue éloignée (DATA-05c). Aucune expiration, les
  images actives sont réécrites par l'`overview-worker`.
- Une notification `OBJECT_FINALIZE` du bucket `snapshots` publie dans le topic
  `snapshot-ready`, au format `JSON_API_V1`, sans enveloppe métier
  ([catalogue](../../docs/events.md), section 5). L'agent de service Cloud
  Storage reçoit `roles/pubsub.publisher` sur ce seul topic.

Aucun abonnement n'écoute encore `snapshot-ready` : l'abonnement push OIDC vers
le `snapshot-notifier` est créé avec lui (SRV-05, BOT-07b). D'ici là, une
notification publiée n'est conservée par aucun abonnement. Aucune identité ne
reçoit encore de droit sur les buckets : chaque worker recevra son rôle objet sur
le bucket qu'il utilise, pas un rôle projet.

## Secrets

Les conteneurs et valeurs vivent dans Secret Manager ; ce stack donne à chaque
runtime `secretAccessor` sur les seuls secrets référencés dans le module
`function`. Utiliser une version numérique activée, jamais une valeur de secret
dans Terraform. Voir [alimentation et rotation](../iam/SECRETS.md).

## Vérification locale et plan

Depuis la racine du dépôt, construire les sources avant un plan qui les archive :

```sh
cd app
npm ci
npm run build:functions
cd ../infra/serverless
terraform init -backend=false
terraform validate
terraform test
```

Les tests racine simulent les providers. Les tests de chaque module sont lancés
séparément par la CI ; Terraform ne les découvre pas automatiquement depuis la
racine. Pour un plan distant, réinitialiser ensuite le backend sélectionné :

```sh
terraform init -reconfigure -backend-config=backends/dev.hcl
terraform plan -var-file=dev.tfvars
```

Remplacer ensemble les références dev par prd pour viser prd. Un plan distant
lit GCP et le state : ce n'est pas un test sans accès cloud.

## Déploiement, vérification et retrait

Utiliser [Deploy](../../docs/deployment.md#6-déployer-dev-par-la-ci), pas un
déploiement `gcloud functions deploy` parallèle à Terraform. Un lancement manuel
vise dev ; un tag `v*` déclenche aussi prd. Lire les plans et valider la portée
avant le déclenchement.

Pour l'essai Discord, l'accord de préparation ne vaut pas accord de déploiement.
Le workflow actuel ne s'arrête pas entre plan/apply et bascule Gateway : ne pas
le lancer avant validation du mécanisme de revues séparées décrit dans le guide
proxy. Aucun workflow de déploiement n'est modifié pour cet essai.

Après application, vérifier les outputs, URLs, génération de source, identité
runtime et policies d'invocation. Tester un appel autorisé et un refus anonyme,
puis l'intégration concernée : callback Discord, JWT Firebase ou push Pub/Sub.
Les tests simulés ne prouvent ni ces permissions réelles ni le délai de réponse.

`Destroy` supprime d'abord Gateway puis les ressources de ce stack, mais conserve `iam`, `access` et
`bootstrap`. Les archives gérées dans ce state sont supprimées comme objets
courants ; les versions/rétentions du bucket peuvent conserver des données et
des coûts. Consulter [suppression et reprise](../../docs/deployment.md#suppression)
avant tout nettoyage complet ; ne pas supprimer des generations ou states sans
examiner leurs usages et sauvegardes.
