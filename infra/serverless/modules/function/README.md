# Module function

Une instance du module crée une **Cloud Run function** (Cloud Functions v2) et une identité d'exécution dédiée. Google construit l'image à partir d'une archive ZIP : aucun Dockerfile, aucun serveur HTTP à écrire. Le handler exporté reçoit `(request, response)` et termine son travail avant de répondre.

L'archive est l'artefact de release ([ADR-0008](../../../../docs/adr/0008-compute-cloud-run-functions.md)) : elle est construite **une fois** en CI, identifiée par son SHA-256, puis copiée à l'identique en dev et en prd. Le module exige l'objet `<sha256>.zip` et sa **génération GCS exacte**, jamais `latest`. Google reconstruit une image par environnement ; c'est l'archive, pas le digest d'image, qui garantit la même release.

Exemple à ajouter au stack lorsque l'archive et l'identité de build existent :

```hcl
module "discord_proxy" {
  source = "./modules/function"

  project_id   = var.project_id
  region       = var.region
  name         = "discord-proxy"
  service_type = "proxy"
  labels       = local.labels

  source_archive = {
    bucket     = "cloud-pixelwar-dev-function-sources"
    object     = "functions/discord-proxy/<sha256>.zip"
    generation = "1234567890123456"
    sha256     = "<sha256>"
  }
  entry_point           = "handleDiscordRequest"
  build_service_account = "projects/cloud-pixelwar-dev/serviceAccounts/function-builder@cloud-pixelwar-dev.iam.gserviceaccount.com"
  build_repository      = "projects/cloud-pixelwar-dev/locations/europe-west1/repositories/pixelwar"

  min_instances = var.environment == "prd" ? 1 : 0
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

- Le ZIP contient le JavaScript compilé, `package.json` et `package-lock.json`. Cloud Build installe les dépendances verrouillées (`npm ci`) : aucune plage de versions n'est résolue au déploiement.
- Le nom de l'objet est le SHA-256 du fichier, éventuellement préfixé par un chemin (`functions/<nom>/<sha256>.zip`). Le module vérifie cette correspondance.
- `generation` doit être un entier positif explicite. Il fige les octets même si l'objet est réécrit.
- La CI vérifie le SHA-256 des octets téléversés dans chaque projet avant de les référencer. Un même SHA peut avoir une génération différente par bucket : c'est normal.
- Le bucket est versionné et conserve 30 jours de générations non courantes, assez pour le rejeu de 15 jours de DATA-02.

## Sécurité et limites

- Aucun binding `allUsers` ou `allAuthenticatedUsers`. `service_type` distingue `proxy` et `worker` (valeur par défaut), conformément aux ADR-0002/0008.
- Un proxy accepte le réseau public (`ALLOW_ALL`) pour qu'API Gateway puisse l'appeler, mais l'IAM reste obligatoire. La gateway recevra `roles/run.invoker` sur chaque proxy dans SRV-04b. Vérifier aussi l'absence de droits d'invocation publics hérités du projet.
- Un worker n'accepte que l'ingress interne (`ALLOW_INTERNAL_ONLY`). La documentation Cloud Run autorise explicitement les abonnements Pub/Sub du même projet à utiliser l'URL `run.app` d'un service interne. Le worker reçoit une seconde identité d'invocation, différente de l'identité d'exécution, avec `roles/run.invoker` limité à cette fonction.
- SRV-05 utilisera `invoker_service_account_email` pour le token OIDC de l'abonnement, et accordera `iam.serviceAccounts.actAs` au deployer et `roles/iam.serviceAccountTokenCreator` à l'agent Pub/Sub sur cette identité. Le module expose aussi `invoker_service_account_name`.
- Le build passe par `build_service_account`, une identité dédiée du bootstrap. Elle a seulement `logging.logWriter`, `storage.objectViewer` sur le bucket de sources et `artifactregistry.writer` sur le dépôt. Le compte de build par défaut n'est jamais utilisé.
- Le compte de déploiement doit pouvoir créer la fonction et agir comme son compte d'exécution (`iam.serviceAccounts.actAs`). L'agent de service Cloud Functions porte `roles/cloudfunctions.serviceAgent`.
- Les secrets doivent déjà exister (SRV-03). Seules leurs références entrent dans Terraform ; le module donne `secretAccessor` secret par secret à l'identité d'exécution. Les versions sont numériques, jamais `latest`.
- Seuls les rôles d'observabilité sont attribués au niveau projet : logs, traces, métriques et `telemetry.tracesWriter` pour l'ingestion OTLP (SRV-08). Les droits métier (Firestore, Pub/Sub, buckets) s'ajoutent selon le besoin de chaque fonction, hors du module.
- `min_instances`, `max_instances`, `concurrency`, `timeout_seconds`, `cpu` et `memory` sont configurables par fonction. Le rendu d'une grille complète peut nécessiter bien plus de mémoire que les proxies ; limiter sa concurrence.
