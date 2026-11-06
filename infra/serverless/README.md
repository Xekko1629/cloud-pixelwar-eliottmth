# Stack serverless — SRV-01

Choix retenu : **Cloud Run services**, avec images conteneur promues par digest entre dev et prd, conformément à [ADR-0001](../../docs/adr/0001-compute-cloud-run-typescript.md).

Le module distingue les proxies (`service_type = "proxy"`, ingress public avec IAM) des workers (`service_type = "worker"` par défaut, ingress interne et identité d'invocation Pub/Sub dédiée), conformément aux ADR-0001 et ADR-0002.

Ce squelette ne déploie encore aucun service : les modules seront instanciés lorsque les images des proxies et workers seront disponibles. Le [module service](modules/service/README.md) est prêt à être utilisé.

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
| `infra/iam` (existant) | `iam` | Identités de CI et Workload Identity |
| `infra/bootstrap` (SRV-01) | `bootstrap` | APIs serverless et Artifact Registry persistants |
| `infra/serverless` | `serverless` | Services applicatifs et leurs identités |

Les buckets de state sont ceux déjà utilisés par foundation. Ce ticket ne les recrée pas et ne migre aucune ressource IAM. Coordonner ce découpage avec BOOT-05, qui décrit un bootstrap plus large que ce qui est actuellement présent sur prod.

Appliquer le bootstrap avant de publier les premières images. Son registry est protégé par `prevent_destroy` et ne dépend pas du state serverless. La cleanup policy garde les 10 versions les plus récentes par image et cible les autres versions de plus de 7 jours. Elle est initialement en **dry run** : vérifier les résultats et la conservation des releases encore utilisées avant d'activer les suppressions effectives. Une version ancienne toujours déployée doit rester disponible pour un destroy/re-apply ou un rollback.

## Vérifications locales sans accès GCP

Depuis chacun des répertoires `infra/bootstrap` et `infra/serverless` :

```sh
terraform init -backend=false
terraform validate
```

Le module peut aussi être validé depuis `infra/serverless/modules/service` avec les mêmes commandes. Depuis ce répertoire,
`terraform test` exécute les tests du module avec un provider simulé, sans créer de ressource GCP.

## Initialisation par environnement

Exemple depuis le répertoire du stack concerné, avec une identité GCP autorisée :

```sh
terraform init -reconfigure -backend-config=backends/dev.hcl
terraform plan -var-file=dev.tfvars
```

Remplacer `dev` par `prd` pour la production. Ces commandes ne font pas d'apply. Le bootstrap est persistant et s'applique séparément comme le stack IAM.

La CI de PR détecte désormais `bootstrap`, `serverless` et le module `service` pour le formatage, la validation et les tests sans backend. Le module est testé séparément : Terraform ne découvre pas automatiquement ses tests depuis la racine.

SRV-03 intègre désormais ce stack au déploiement : exécution manuelle →
`foundation` puis `serverless` en dev ; tag `v*` → même séquence en dev, puis en
prd, puis `runners` en prd. Un merge/push sur la branche `prod` seul ne déclenche
pas d'apply. Les contrôles de release incluent aussi `bootstrap`, `serverless`
et le module `service`. Le bootstrap persistant doit déjà avoir été appliqué
séparément dans chaque projet pour activer les APIs ; il n'est pas auto-déployé.

Le destroy manuel supprime `serverless` (sans les secrets, gérés par `iam`), puis
`runners` en prd, puis `foundation`. `iam` et `bootstrap` sont conservés.
Les plans distants de PR restent limités à `foundation` ; le plan serverless est
calculé dans le job d'apply avant application. Faire relire un plan serverless
séparé avant le premier déclenchement, voir [SECRETS.md](../iam/SECRETS.md).
Le build/push des images et la promotion applicative par digest restent dans SRV-02.
