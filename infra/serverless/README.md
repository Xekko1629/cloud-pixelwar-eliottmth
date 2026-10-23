# Stack serverless — SRV-01

Choix retenu : **Cloud Run services**, avec images conteneur promues par digest entre dev et prd, conformément à [ADR-0001](../../docs/adr/0001-compute-cloud-run-typescript.md).

Le module distingue les proxies (`service_type = "proxy"`, ingress public avec IAM) des workers (`service_type = "worker"` par défaut, ingress interne et identité d'invocation Pub/Sub dédiée), conformément aux ADR-0001 et ADR-0002.

Ce squelette ne déploie encore aucun service : les modules seront instanciés lorsque les images des proxies et workers seront disponibles. Le [module service](modules/service/README.md) est prêt à être utilisé.

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

Les plans distants et déploiements ciblent encore `foundation`. L'intégration des nouveaux stacks aux plans dev/prd, le build/push des images et leur déploiement relèvent de SRV-02 ; ce squelette n'est pas encore automatiquement déployé.
