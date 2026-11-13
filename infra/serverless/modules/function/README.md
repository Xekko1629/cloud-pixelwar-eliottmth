# Module function

Une instance du module crée une **Cloud Run function** (Cloud Functions v2) et une identité d'exécution dédiée. Google construit l'image à partir d'une archive ZIP : aucun Dockerfile, aucun serveur HTTP à écrire. Le handler exporté reçoit `(request, response)` et termine son travail avant de répondre.

Le module reçoit une archive identifiée par son SHA-256 et sa **génération GCS
exacte**, jamais `latest`. Selon [ADR-0009](../../../../docs/adr/0009-sources-fonctions-terraform.md),
la CI construit les sources, puis le module `function-source` crée et téléverse
le ZIP dans chaque environnement. Le mécanisme ne copie pas une archive unique
de dev vers prd. Google construit l'image runtime ; le registre n'est pas une
entrée d'image à fournir au module.

Exemple à ajouter au stack lorsque l'archive et l'identité de build existent :

```hcl
module "discord_proxy" {
  source = "./modules/function"

  project_id   = var.project_id
  region       = var.region
  name         = "discord-proxy"
  service_type = "proxy"
  labels       = { environment = var.environment }

  source_archive = {
    bucket     = "cloud-pixelwar-dev-function-sources"
    object     = "functions/discord-proxy/<sha256>.zip"
    generation = "1234567890123456"
    sha256     = "<sha256>"
  }
  entry_point           = "handleDiscordRequest"
  build_service_account = "projects/cloud-pixelwar-dev/serviceAccounts/function-builder@cloud-pixelwar-dev.iam.gserviceaccount.com"
  build_repository      = "projects/cloud-pixelwar-dev/locations/europe-west1/repositories/pixelwar"

  min_instances = 0
  max_instances = 5

  environment_variables = {
    APP_ENV = var.environment
  }
  secrets = {
    DISCORD_PUBLIC_KEY = {
      secret  = "discord-public-key"
      version = "1"
    }
  }
}
```

Le bootstrap crée le bucket `*-function-sources`, l'identité `function-builder` et le dépôt Artifact Registry. Il expose `function_source_bucket`, `function_builder_service_account_name` et `repository_name` pour renseigner ces trois champs.

## Contrat de l'archive

- Le ZIP produit par le build contient le JavaScript compilé et `package.json`,
  sans lockfile de déploiement. Les versions directes du manifeste sont extraites
  du lockfile du dépôt ; Cloud Build résout les transitives par `npm install`.
- Le nom de l'objet est le SHA-256 du fichier, éventuellement préfixé par un chemin (`functions/<nom>/<sha256>.zip`). Le module vérifie cette correspondance.
- `generation` doit être un entier positif explicite. Il fige les octets même si l'objet est réécrit.
- Le module vérifie le format du SHA-256 et sa correspondance au nom d'objet,
  pas les octets distants eux-mêmes. `function-source` calcule le SHA-256 local
  avec `archive_file` et transmet la génération renvoyée par GCS.
- La rétention du bucket versionné est configurée dans `infra/bootstrap`.
  Sa conservation ne constitue pas un rollback automatique ; contrôler la
  disponibilité des sources et la compatibilité des données avant une reprise.

## Sécurité et limites

- Aucun binding `allUsers` ou `allAuthenticatedUsers`. `service_type` distingue `proxy` et `worker` (valeur par défaut), conformément aux ADR-0002/0008.
- Un proxy accepte le réseau public (`ALLOW_ALL`) pour qu'API Gateway puisse l'appeler, mais l'IAM reste obligatoire. Le [module api-gateway](../api-gateway/README.md) donne `roles/run.invoker` à la gateway sur chaque proxy routé, à partir des outputs `name`, `uri` et `service_type` (un worker est refusé). Vérifier aussi l'absence de droits d'invocation publics hérités du projet.
- Un worker n'accepte que l'ingress interne (`ALLOW_INTERNAL_ONLY`). La documentation Cloud Run autorise explicitement les abonnements Pub/Sub du même projet à utiliser l'URL `run.app` d'un service interne. Le worker reçoit une seconde identité d'invocation, différente de l'identité d'exécution, avec `roles/run.invoker` limité à cette fonction.
- Pour l'abonnement push OIDC, utiliser `invoker_service_account_email`, accorder
  `iam.serviceAccounts.actAs` au créateur de l'abonnement et
  `roles/iam.serviceAccountTokenCreator` à l'agent Pub/Sub sur cette identité.
  Le module expose aussi `invoker_service_account_name`.
- Le build passe par `build_service_account`, une identité dédiée du bootstrap. Elle a seulement `logging.logWriter`, `storage.objectViewer` sur le bucket de sources et `artifactregistry.writer` sur le dépôt. Le compte de build par défaut n'est jamais utilisé.
- Le compte de déploiement doit pouvoir créer la fonction et agir comme son compte d'exécution (`iam.serviceAccounts.actAs`). L'agent de service Cloud Functions porte `roles/cloudfunctions.serviceAgent`.
- Les secrets doivent exister avec leurs versions activées. Seules leurs
  références entrent dans Terraform ; le module donne `secretAccessor` secret
  par secret au runtime. Les versions sont numériques, jamais `latest`.
- Seuls les rôles d'observabilité sont attribués au niveau projet : logs, traces, métriques et `telemetry.tracesWriter` pour l'ingestion OTLP (SRV-08). Les droits métier (Firestore, Pub/Sub, buckets) s'ajoutent selon le besoin de chaque fonction, hors du module.
- `min_instances`, `max_instances`, `concurrency`, `timeout_seconds`, `cpu` et `memory` sont configurables par fonction. Le rendu d'une grille complète peut nécessiter bien plus de mémoire que les proxies ; limiter sa concurrence.

Mesurer les démarrages à froid et le délai total avant de prévoir une instance
minimale pour un proxy Discord. Cette modification a un coût et relève d'une
configuration approuvée, pas d'un prérequis automatique du module.
