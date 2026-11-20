# Stack Gateway

## Responsabilités et contrat

Ce stack possède l'API, ses configurations immuables, la Gateway, son identité
et les droits `run.invoker` sur les proxies routés. Les fonctions et leurs
identités restent dans `infra/serverless`. Voir [ADR-0010](../../docs/adr/0010-separation-gateway-serverless.md).

Les deux stacks ont des states distincts, avec les préfixes `serverless` et
`gateway` dans le bucket de l'environnement. Le catalogue HTTP est dans
[`routes.tf`](routes.tf) ; le module réutilisable reste dans
[`serverless/modules/api-gateway`](../serverless/modules/api-gateway/README.md).

`terraform_remote_state.serverless` lit l'output racine `gateway_contract` :

```text
schema_version = 1
project_id, environment, region = contexte de l'installation
backends = { clé = { function_name, uri, service_type } }
```

Le projet, l'environnement, la région et la version doivent correspondre. Un
contrat absent ou incompatible fait échouer le plan ; un contrat valide avec
`backends = {}` ne crée pas de Gateway. Seuls les proxies sont acceptés.
Ce contrat contient des adresses et identifiants, jamais des valeurs de secrets.
Attention : l'identité lisant les outputs par `terraform_remote_state` peut lire
le **snapshot complet** du state source. Ne pas y introduire de valeurs sensibles
et réexaminer les droits si le contenu de ce state change.

## Ordre des opérations

- Déploiement : `foundation` et `bootstrap`, puis `serverless`, puis `gateway`.
- Suppression : `gateway` avant `serverless`, puis `foundation` ; les runners prd
  restent une branche parallèle de l'orchestration.
- Ne pas lancer simultanément deux releases ou un deploy et un destroy du même
  environnement : les verrous par stack ne sont pas un verrou global de release.

Un plan PR Gateway utilise le dernier contrat **appliqué**, pas les endpoints
futurs d'un autre plan. Si le contrat n'existe pas encore, la CI indique
explicitement « Gateway plan deferred » : ce n'est pas un plan réel validé.
Validation et tests statiques restent exécutés. Après l'apply serverless réussi,
le job Gateway recalcule son plan avec le contrat publié.

## Vérification et outputs

```sh
terraform -chdir=infra/gateway init -backend=false
terraform -chdir=infra/gateway validate
terraform -chdir=infra/gateway test
python3 scripts/tests/test_gateway_migration.py
```

Pour lire les outputs après un déploiement dev réussi :

```sh
terraform -chdir=infra/gateway init -reconfigure -backend-config=backends/dev.hcl
terraform -chdir=infra/gateway output -raw gateway_url
terraform -chdir=infra/gateway output gateway_routes
```

L'URI de la fonction reste un output de `infra/serverless`. L'URL Gateway n'est
plus un output de ce stack. L'[installation générale](../../docs/deployment.md)
et le [test Discord](../../docs/discord-hello.md) distinguent ces deux lectures.

## Migration d'une installation existante

Avant tout apply, figer les opérations concurrentes et sauvegarder les snapshots
hors du dépôt, avec des droits d'accès restreints. Examiner les ressources de
`serverless` avec `terraform state list` et vérifier l'inventaire GCP correspondant.
Ne jamais lancer `state rm`, `untaint`, une suppression manuelle ou un import
pour contourner une erreur sans plan de migration approuvé.

### Aucune ressource Gateway dans le state source

Il n'y a pas de ressource Gateway à transférer. Le bloc `removed` dans serverless
ne supprime rien. Le plan doit seulement publier le nouveau contrat et, si une
fonction est marquée `tainted`, annoncer sa destruction **avant** sa recréation.
Ce remplacement reste une suppression réelle de fonction : le faire valider
avant de déclencher la pipeline. L'absence de `create_before_destroy` explicite
dans le module fonction ne dispense pas de vérifier ce plan.

Après l'apply serverless réussi, Gateway peut être créé depuis son propre state.
La disparition de l'erreur de nom ne prouve pas à elle seule le succès du build,
les contrôles IAM ou le fonctionnement du callback.

### Des ressources Gateway sont déjà gérées par serverless

Les jobs d'apply/destroy serverless s'arrêtent via
`scripts/check-gateway-migration.sh`. Ne pas ignorer ce garde-fou : appliquer
directement le nouveau stack provoquerait des conflits de noms.

Préparer une migration déclarative revue, selon la
[procédure HashiCorp](https://developer.hashicorp.com/terraform/language/state/refactor#remove-and-import) :

1. Inventorier **toutes** les instances de l'ancien `module.api_gateway`, leurs
   IDs et paramètres : API, config active, Gateway, service géré, identité et
   bindings IAM. Relever l'URL et la config active avant migration.
   Si le contrat d'outputs n'existe pas encore, le publier dans une étape
   préparatoire revue qui **conserve** l'ancien module Gateway et son ownership.
   Il doit être disponible avant de planifier l'adoption par le nouveau stack.
2. Préparer les blocs `import` du stack Gateway avec ces IDs, et garder les
   adresses/paramètres compatibles. Les formats d'ID dépendent du type de
   ressource ; les vérifier dans la documentation du provider, sans les deviner.
3. Préparer le retrait d'ownership dans serverless avec son bloc `removed`,
   `destroy = false`, sans autre changement applicatif. Pour cette étape seulement,
   faire approuver une exécution contrôlée du plan de migration en dehors du job
   standard bloqué par le garde-fou.
4. Examiner les deux plans : aucune suppression dans le plan de retrait, et
   imports sans recréation de l'identité ou de la Gateway dans le plan d'adoption.
   Une config immuable éventuellement remplacée doit garder le renouvellement
   sans interruption et être explicitement relue.
5. Après accord explicite, appliquer le retrait puis les imports, sans laisser
   deux states propriétaires des mêmes ressources. Refaire les plans des deux
   stacks, contrôler les policies et le callback avant de reprendre les workflows.

Les blocs `removed` et `import` gardent la trace de la migration. Ne pas copier
un state dans un autre ni supprimer/recréer une Gateway existante pour gagner du
temps. Cette procédure est distincte de la reprise d'une fonction en échec.
