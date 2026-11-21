# Identités et rôles IAM

Inventaire des identités du projet (SEC-01) : qui a quel rôle, sur quelle
ressource, et pourquoi. Il décrit le contrat du code Terraform de cette version.
La vérification de l'état réel passe par les plans, les tests `infra/iam` et le
contrôle [« rien de public »](ci.md#contrôle--rien-de-public--sec-01).

Règles générales :

- aucune identité de service n'a `roles/owner` ni `roles/editor` ;
- aucun composant n'utilise le compte de service Compute par défaut : chaque
  fonction, service Cloud Run et pool GKE a son propre compte ;
- un rôle est accordé sur la ressource concernée quand c'est possible, et au
  niveau projet seulement quand la ressource n'existe pas encore ou que le rôle
  n'existe qu'à ce niveau (écriture de logs, métriques, traces) ;
- l'identité de build n'a aucun droit runtime, et une identité runtime n'a aucun
  droit de build.

## CI (GitHub Actions)

Les deux identités sont créées par `infra/iam` et utilisées par Workload Identity
Federation, sans clé. L'environnement GitHub sélectionne l'identité :

| Identité | Rôles | Ressource | Justification |
|---|---|---|---|
| `github-terraform` (deployer), environnement `<env>` | `storage.admin`, `artifactregistry.admin`, `iam.serviceAccountAdmin`, `iam.serviceAccountUser`, `cloudfunctions.admin`, `run.admin`, `pubsub.admin`, `datastore.owner`, `cloudscheduler.admin`, `apigateway.admin`, `serviceusage.serviceUsageAdmin`, `monitoring.editor`, `logging.configWriter`, `compute.networkAdmin` | Projet | Un rôle par type de ressource que la CI crée (`deployer_roles`). Les rôles admin couvrent aussi les policies IAM de ces ressources. |
| | `container.admin` | Projet, prd seulement | Cluster des runners, CRD et RBAC des charts Helm (`deployer_cluster_roles`). |
| | `resourcemanager.projectIamAdmin` **sous condition** `modifiedGrantsByRole` | Projet | Ne peut accorder ou retirer que les rôles de `deployer_grantable_roles` : `logging.logWriter`, `monitoring.metricWriter`, `cloudtrace.agent`, `telemetry.tracesWriter`, `datastore.user`, `datastore.viewer`, `artifactregistry.reader`, `storage.objectViewer`. Jamais owner, editor ou un rôle d'admin IAM. |
| | `deployerSecretIamPolicy` (personnalisé) | Chaque secret applicatif | Donner `secretAccessor` au runtime d'une fonction sur son secret. |
| | `deployerServiceAccountIamPolicy` (personnalisé), `iam.serviceAccountUser` | `external-secrets` (prd) | Bindings ajoutés par les stacks jetables sur des comptes persistants. Les comptes créés par serverless (invokers, `session-signer`) sont couverts par `iam.serviceAccountAdmin`. |
| | `secretmanager.secretAccessor` | Secret `arc-github-app` (prd) | Jeton GitHub App de courte durée pour gérer les variables des runners. |
| `github-planner` (planner), environnement `<env>-plan` | `viewer` | Projet | Plans de PR en lecture seule. |
| | `plannerResourceIamRead` (personnalisé) : `storage.buckets`, `pubsub.topics`, `pubsub.subscriptions`, `iam.serviceAccounts` `.getIamPolicy` | Projet | Lire les policies que `viewer` ne couvre pas, pour rafraîchir les bindings pendant un plan. |
| | `storage.objectViewer` | Bucket des sources de fonctions | Comparer les archives pendant un plan serverless. |

## Build des fonctions

| Identité | Rôles | Ressource | Justification |
|---|---|---|---|
| `function-builder` | `artifactregistry.writer` | Dépôt `pixelwar` | Pousser l'image construite par Cloud Build. |
| | `storage.objectViewer` | Bucket des sources de fonctions | Lire l'archive soumise. |
| | `storage.objectViewer` **sous condition** | Projet, objets `gcf-v2-sources-<numéro>-<région>/` seulement | Lire la copie que Cloud Functions dépose dans son propre bucket, qui peut ne pas exister au premier bootstrap. |
| | `logging.logWriter` | Projet | Logs de build. |

Le deployer reçoit `iam.serviceAccountUser` au niveau projet pour attacher
`function-builder` et les identités runtime aux fonctions.

## Fonctions et services applicatifs

Chaque fonction (`infra/serverless/modules/function`) a une identité runtime
portant son nom :

| Identité | Rôles | Ressource | Justification |
|---|---|---|---|
| `<fonction>` (runtime de chaque fonction) | `logging.logWriter`, `monitoring.metricWriter`, `cloudtrace.agent`, `telemetry.tracesWriter` | Projet | Logs JSON, métriques et traces. Ces rôles n'existent qu'au niveau projet. |
| | `secretmanager.secretAccessor` | Les secrets de la fonction uniquement | `discord-hello` : `discord-public-key`. `discord-proxy` : `discord-public-key`, `discord-application-id`. `command-worker` : `discord-application-id`, `admin-allowlist`. `draw-worker`, `discord-notifier` : `discord-application-id`. `auth-proxy` : `discord-application-id`, `discord-oauth-client-secret`. |
| `discord-proxy` | `pubsub.publisher` | Topic `discord-command` | Publier les commandes vérifiées. |
| `command-worker` | `pubsub.publisher` | Topic `pixel-draw` | Publier le dessin d'un `/draw`. |
| `draw-worker` | `datastore.user` | Projet | Transaction DATA-02 : tuiles, quotas, résultats, `config/global`. Rôle Firestore disponible seulement au niveau projet. |
| | `pubsub.publisher` | Topics `pixel-processed`, `pixel-rejected` | Publier le résultat de chaque dessin. |
| `auth-proxy` | `iam.serviceAccountTokenCreator` | `session-signer` seulement | Signer les JWT de session avec `signJwt` (ADR-0012). |
| `invoke-<hash>` (un par worker) | `run.invoker` | Le service du worker | Identité OIDC de l'abonnement push Pub/Sub. Les workers sont en ingress interne. |
| `pixelwar-gateway` | `run.invoker` | Chaque backend routé par la gateway | Seule identité qui appelle les proxys. Les proxys sont en ingress `ALLOW_ALL`, mais protégés par IAM. |
| `session-signer` | aucun | — | Émetteur des JWT. Ne porte aucun rôle et n'exécute aucun code. Google garde ses clés, la gateway vérifie les jetons avec sa clé publique. |
| `frontend` | aucun | — | Sert les fichiers statiques. Le service est le seul public (`allUsers` en `run.invoker`, ADR-0011). |

## Agents de service Google

| Identité | Rôles | Ressource | Justification |
|---|---|---|---|
| Agent Pub/Sub (`service-<numéro>@gcp-sa-pubsub`) | `iam.serviceAccountTokenCreator` | L'invoker de chaque worker abonné (`command-worker`, `draw-worker`, `discord-notifier`) | Émettre le jeton OIDC des pushes. |
| | `pubsub.publisher` | Le topic `<abonnement>-dlq` de chaque abonnement | Router les messages en échec vers la dead letter queue. |
| | `pubsub.subscriber` | Chaque abonnement push | Retirer de l'abonnement un message transféré en dead letter. |

Les autres agents (Cloud Build, Cloud Functions, Cloud Run, Artifact Registry,
GKE…) reçoivent leurs rôles `*.serviceAgent` de Google à l'activation des APIs.
Terraform ne les gère pas.

## Cluster des runners (prd)

| Identité | Rôles | Ressource | Justification |
|---|---|---|---|
| `gke-nodes` | `logging.logWriter`, `monitoring.metricWriter`, `artifactregistry.reader` | Projet | Logs et métriques des nœuds, téléchargement des images. Les deux pools l'utilisent à la place du compte Compute par défaut. |
| `external-secrets` | `secretmanager.secretAccessor` | Secret `arc-github-app` | Copier la GitHub App dans le cluster pour ARC. |
| | `iam.workloadIdentityUser` accordé au KSA `external-secrets/external-secrets` | `external-secrets` | Workload Identity, sans clé. |

## Accès humains

`infra/access` (appliqué à la main) donne `roles/editor` aux membres de l'équipe
et à l'encadrant, `billing.viewer` à l'encadrant sur le compte de facturation, et,
en dev seulement, `secretAccessor` sur les secrets Discord du bot. Le détail est
dans [le README d'access](../infra/access/README.md).

## Ajouter une identité ou un rôle

1. Créer un compte par composant, jamais un compte partagé.
2. Donner le rôle sur la ressource quand elle existe. Un nouveau rôle accordé au
   niveau projet par la CI doit être ajouté à `deployer_grantable_roles`, sinon
   l'apply est refusé.
3. Ajouter la ligne dans ce tableau, dans la même PR.
