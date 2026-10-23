# Module service

Une instance du module crée un service Cloud Run v2 et une identité d'exécution dédiée. L'image doit être fournie par digest pour déployer le même artefact en dev et prd (SRV-02). Le conteneur doit écouter sur `0.0.0.0:8080` et terminer son traitement avant de répondre : le CPU est alloué pendant les requêtes.

Exemple à ajouter au stack lorsque l'image existe (le digest provient de la CI) :

```hcl
module "discord_proxy" {
  source = "./modules/service"

  project_id = var.project_id
  region     = var.region
  name       = "discord-proxy"
  image      = var.discord_proxy_image
  labels     = local.labels

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

Déclarer aussi la variable `discord_proxy_image` dans le stack appelant.

## Sécurité et limites

- Aucun binding `allUsers` ou `allAuthenticatedUsers`, ni droit d'invocation ajouté automatiquement. La gateway et les abonnements Pub/Sub recevront un droit `roles/run.invoker` sur leur seul service cible (SRV-04b / SRV-05).
- L'ingress accepte le réseau public pour que la gateway puisse appeler le backend, mais IAM reste obligatoire. Cela ne signifie pas un service public. Vérifier aussi l'absence de droits d'invocation publics hérités du projet.
- Les secrets doivent déjà exister (SRV-03). Seules leurs références entrent dans Terraform ; le module donne `secretAccessor` secret par secret, à l'identité du service. Ils sont injectés comme variables d'environnement.
- Seuls les rôles d'observabilité sont attribués au niveau projet. Les droits métier (Firestore, Pub/Sub, buckets) seront ajoutés selon les besoins de chaque service, hors du module.
- Le compte de déploiement doit pouvoir créer le service et agir comme son compte d'exécution (`iam.serviceAccounts.actAs`). Il ne s'agit pas du compte d'exécution de l'application.
- `min_instances`, `max_instances`, `concurrency`, `timeout_seconds`, `cpu` et `memory` sont configurables par service. Le rendu d'une grille complète peut nécessiter bien plus de mémoire que les proxies ; limiter sa concurrence.
