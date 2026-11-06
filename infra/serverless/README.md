# Stack serverless — SRV-01

Choix retenu : **Cloud Run functions** (Cloud Functions v2), déployées depuis une archive de sources identifiée par son SHA-256 et copiée à l'identique entre dev et prd, conformément à [ADR-0008](../../docs/adr/0008-compute-cloud-run-functions.md). Google construit l'image d'exécution dans chaque projet ; l'artefact promu est l'archive, pas un digest d'image.

Le module [function](modules/function/README.md) distingue les proxies (`service_type = "proxy"`, ingress public avec IAM) des workers (`service_type = "worker"` par défaut, ingress interne et identité d'invocation Pub/Sub dédiée), conformément aux ADR-0002 et ADR-0008.

Ce squelette ne déploie encore aucune fonction : les modules seront instanciés lorsque les archives des proxies et workers seront produites par SRV-02. Le module `function` est prêt à être utilisé.

## Secrets applicatifs — SRV-03

`secrets.tf` déclare les conteneurs Secret Manager dans chaque projet, sans
valeurs ni versions gérées par Terraform. Voir [SECRETS.md](SECRETS.md) pour le
catalogue, l'alimentation hors Git, les accès par service et la rotation.
Un destroy supprime les secrets et leurs versions : les valeurs devront être
réinjectées lors d'une reconstruction, elles ne sont pas sauvegardées dans le state.

## Organisation des states

| Stack | Préfixe GCS | Rôle |
| --- | --- | --- |
| `infra/iam` (existant) | `iam` | Identités de CI et Workload Identity |
| `infra/bootstrap` (SRV-01) | `bootstrap` | APIs serverless, registre d'images, bucket d'archives et identité de build persistants |
| `infra/serverless` | `serverless` | Fonctions applicatives et leurs identités |

Les buckets de state sont ceux déjà utilisés par foundation. Ce ticket ne les recrée pas et ne migre aucune ressource IAM. Coordonner ce découpage avec BOOT-05, qui décrit un bootstrap plus large que ce qui est actuellement présent sur prod.

Appliquer le bootstrap avant de publier la première archive. Il crée :

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

Remplacer `dev` par `prd` pour la production. Ces commandes ne font pas d'apply. Le bootstrap est persistant et s'applique séparément comme le stack IAM.

La CI de PR détecte désormais `bootstrap`, `serverless` et le module `function` pour le formatage, la validation et les tests sans backend. Le module est testé séparément : Terraform ne découvre pas automatiquement ses tests depuis la racine.

SRV-03 intègre désormais ce stack au déploiement : exécution manuelle →
`foundation` puis `serverless` en dev ; tag `v*` → même séquence en dev, puis en
prd, puis `runners` en prd. Un merge/push sur la branche `prod` seul ne déclenche
pas d'apply. Les contrôles de release incluent aussi `bootstrap`, `serverless`
et le module `function`. Le bootstrap persistant doit déjà avoir été appliqué
séparément dans chaque projet pour activer les APIs ; il n'est pas auto-déployé.

Le destroy manuel supprime `serverless` (secrets et toutes leurs versions), puis
`runners` en prd, puis `foundation`. `iam` et `bootstrap` sont conservés : le bucket
d'archives permet de redéployer sans reconstruire la release.
Un teardown complet du projet doit d'abord vider `${project_id}-function-sources`
avec toutes ses générations (`gcloud storage rm --recursive --all-versions`) : le
bucket est volontairement non vidé par Terraform pour protéger les releases.
Les plans distants de PR restent limités à `foundation` ; le plan serverless est
calculé dans le job d'apply avant application. Faire relire un plan serverless
séparé avant le premier déclenchement, voir [SECRETS.md](SECRETS.md).
L'empaquetage déterministe, l'upload et la promotion de l'archive restent dans SRV-02.
