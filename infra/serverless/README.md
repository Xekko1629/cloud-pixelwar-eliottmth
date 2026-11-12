# Stack serverless — SRV-01

Choix retenu : **Cloud Run functions** (Cloud Functions v2), déployées depuis une archive de sources identifiée par son SHA-256 et copiée à l'identique entre dev et prd, conformément à [ADR-0008](../../docs/adr/0008-compute-cloud-run-functions.md). Google construit l'image d'exécution dans chaque projet ; l'artefact promu est l'archive, pas un digest d'image.

Le module [function](modules/function/README.md) distingue les proxies (`service_type = "proxy"`, ingress public avec IAM) des workers (`service_type = "worker"` par défaut, ingress interne et identité d'invocation Pub/Sub dédiée), conformément aux ADR-0002 et ADR-0008.

Ce squelette ne déploie encore aucune fonction : les modules seront instanciés lorsque les archives des proxies et workers seront produites par SRV-02. Le module `function` est prêt à être utilisé.

## API Gateway — SRV-04a

`gateway.tf` déclare le catalogue des routes de l'unique point d'entrée public
(`/discord/interactions`, `/auth/*`, `/api/*`, et `/hello` temporairement pour SRV-09)
et appelle le [module api-gateway](modules/api-gateway/README.md).

Une route n'est publiée que lorsque sa fonction proxy est déployée : il suffit
d'ajouter son entrée dans `local.gateway_backends`, à partir des outputs du module
`function`. Tant qu'aucun proxy n'existe, la gateway n'est pas créée (API Gateway
refuse une spécification sans backend) et l'output `gateway_url` vaut `null`.
Les APIs nécessaires (`apigateway`, `servicemanagement`, `servicecontrol`) sont
activées par `infra/iam`.

## Secrets applicatifs — SRV-03

Les conteneurs Secret Manager sont déclarés par le stack persistant `infra/iam`
(`secrets.tf`), plus ici : Secret Manager est la source de vérité, un destroy de
`serverless` ne doit pas effacer les valeurs. Ce stack se contente de donner
`secretAccessor` à chaque fonction sur les secrets qu'elle utilise (module
`service`). Voir [SECRETS.md](../iam/SECRETS.md) pour le catalogue,
l'alimentation hors Git, les accès par service et la rotation.

## Organisation des states

| Stack | Préfixe GCS | Rôle |
| --- | --- | --- |
| `infra/iam` (à la main) | `iam` | APIs, identités de CI, secrets, bucket de state |
| `infra/bootstrap` (CI, jamais détruit) | `bootstrap` | Registre d'images, bucket d'archives et identité de build persistants |
| `infra/serverless` | `serverless` | Fonctions applicatives et leurs identités |

Le bootstrap est appliqué par `Deploy`, avant `serverless`, en dev puis en prd ; `Destroy` ne le cible jamais. Ses APIs sont activées par `infra/iam`, à appliquer avant. Il crée :

- le registre Artifact Registry qui reçoit les images internes construites par Google ;
- le bucket `${project_id}-function-sources`, versionné, privé et non vidé par Terraform ;
- l'identité `function-builder`, avec les trois rôles nécessaires au build.

Le registre et le bucket ne dépendent pas du state serverless : ils survivent à un destroy et permettent de rejouer ou de rollbacker la même release. La cleanup policy du registre ne garde que 10 versions récentes et reste initialement en **dry run**. Une image interne supprimée n'est pas un problème de release : réappliquer la même archive la reconstruit. Le dry run doit tout de même être vérifié avant d'activer les suppressions.

## Vérifications locales sans accès GCP

Depuis chacun des répertoires `infra/bootstrap` et `infra/serverless` :

```sh
terraform init -backend=false
terraform validate
```

Le module peut aussi être validé depuis `infra/serverless/modules/function` avec les mêmes commandes. Depuis ce répertoire,
`terraform test` exécute les tests du module avec un provider simulé, sans créer de ressource GCP.

## Initialisation par environnement

Exemple depuis le répertoire du stack concerné, avec une identité GCP autorisée :

```sh
terraform init -reconfigure -backend-config=backends/dev.hcl
terraform plan -var-file=dev.tfvars
```

Remplacer `dev` par `prd` pour la production. Ces commandes ne font pas d'apply.

La CI de PR détecte désormais `bootstrap`, `serverless` et les modules `function` et `api-gateway` pour le formatage, la validation et les tests sans backend. Les modules sont testés séparément : Terraform ne découvre pas automatiquement ses tests depuis la racine.

Déploiement : exécution manuelle → `foundation` et `bootstrap`, puis `serverless`
en dev ; tag `v*` → même séquence en dev, puis en prd, avec `runners` en prd.
Un merge/push sur la branche `prod` seul ne déclenche pas d'apply. Les contrôles
de release incluent aussi `bootstrap`, `serverless` et le module `function`.
`infra/iam` doit avoir été appliqué à la main avant, pour activer les APIs.

Le destroy manuel supprime `serverless` (sans les secrets, gérés par `iam`) et
`runners` en prd, puis `foundation`. `iam` et `bootstrap` sont conservés : le bucket
d'archives permet de redéployer sans reconstruire la release.
Un teardown complet du projet doit d'abord vider `${project_id}-function-sources`
avec toutes ses générations (`gcloud storage rm --recursive --all-versions`) : le
bucket est volontairement non vidé par Terraform pour protéger les releases.
Chaque PR qui modifie ce stack ou son module publie un plan dev et prd ; le plan serverless est aussi
calculé dans le job d'apply avant application. Relire ce plan de PR avant le
premier déclenchement, voir [SECRETS.md](../iam/SECRETS.md).
L'empaquetage déterministe, l'upload et la promotion de l'archive restent dans SRV-02.
