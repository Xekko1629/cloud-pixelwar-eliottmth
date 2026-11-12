# Intégration et déploiement continus

## Périmètre

Les workflows de `.github/workflows/` contrôlent les contributions et appliquent
les stacks déclarés. Pour installer un environnement vide, suivre le
[guide de déploiement](deployment.md) ; pour les règles de contribution et de
signature, consulter le [GitFlow](gitflow.md).

Une fusion dans `prod` ne déclenche pas d'apply. Le code du workflow de la
référence choisie détermine les ressources traitées ; un répertoire Terraform
supplémentaire n'est pas déployé automatiquement.

## Événements et effets

| Événement | Contrôles | Plans distants | Effets |
| --- | --- | --- | --- |
| PR vers `prod` | Application et stacks sélectionnés | `foundation`, `bootstrap`, `serverless`, dev/prd selon les chemins | Aucun apply |
| Lancement manuel de `Deploy` | Contrôles Terraform | Plan dans chaque job d'apply | `foundation` et `bootstrap` dev, puis `serverless` dev |
| Push d'un tag `v*` | Contrôles Terraform | Plan dans chaque job d'apply | Dev, puis prd : `foundation` et `bootstrap`, puis `serverless` et `runners` prd selon leurs dépendances |
| Lancement manuel de `Destroy` | Confirmation de l'environnement | Préparation du destroy | `serverless` et `runners` prd en parallèle, puis `foundation` |

`iam` et `access` s'appliquent manuellement. `bootstrap` s'applique par CI mais
n'est pas ciblé par `Destroy`. Les plans d'apply ne sont pas les fichiers de
plan des PR : chaque job recalcule son plan et l'applique sans pause de review
entre ces deux étapes. Lire les plans de PR et approuver la release en amont.

Le contrôle d'appartenance du commit à `origin/prod` s'exécute dans `_apply.yml`
pour prd, pas pour les applies dev. Le workflow ne vérifie pas la signature du
tag ; la convention de signature et les protections GitHub sont distinctes.

## Workflows et contrôles

| Fichier | Rôle |
| --- | --- |
| `ci.yml` | Sélection des chemins, contrôles, plans dev/prd et agrégation `CI result` |
| `_app-test.yml` | Node.js 24, Java 21, installation npm, types stricts, couverture, émulateurs et build des fonctions |
| `_fmt.yml`, `_lint.yml` | Format Terraform et règles tflint |
| `_validate.yml`, `_test.yml` | Validation et tests Terraform par stack/module |
| `_plan.yml` | Plan PR avec l'identité de lecture de `<env>-plan` |
| `_apply.yml` | Authentification, build serverless, plan et apply du stack |
| `_destroy.yml` | Authentification, build serverless pour rafraîchir les archives, puis destroy |
| `deploy.yml`, `destroy.yml` | Orchestration et choix des environnements/stacks |

Sur chaque PR vers `prod`, le job `application` exécute les vérifications strictes
TypeScript, les tests Vitest avec un seuil de couverture de 70 % par fichier,
puis les tests d'intégration Firestore/Pub/Sub et le build. Les émulateurs
utilisent un projet fictif sans accès GCP. Les rapports JUnit et de couverture
sont attachés au run. Voir [les commandes de test](testing.md).

Le job `CI result` est toujours publié, même lorsque des stacks sont ignorés, et
échoue si un job requis échoue ou est annulé. Le sélectionner comme contrôle
requis dans la protection de `prod`. Les rapports de test sont des preuves
d'exécution du run, pas une affirmation de couverture métier globale.

## Filtrage des chemins pour les pull requests

`dorny/paths-filter` sélectionne les contrôles Terraform. Consulter les filtres
de `ci.yml` pour les motifs exacts et les jobs réutilisables pour leurs valeurs
par défaut.

| Chemin | Validation/tests Terraform | Plan dev/prd |
| --- | --- | --- |
| `infra/foundation/**` | `foundation` | Oui |
| `infra/bootstrap/**` | `bootstrap` | Oui |
| `infra/serverless/**` | `serverless`, modules concernés | Oui |
| `app/functions/**`, `app/shared/src/**`, manifeste partagé, lockfile npm | `serverless` | Oui |
| `infra/iam/**`, `infra/access/**` | Stack concerné | Non, application manuelle |
| `infra/runners/**` | `runners` | Non |
| `.github/workflows/**` | Ensemble des stacks sélectionnés par les filtres | Selon les jobs de plan |
| Documentation seule | Pas de contrôle Terraform sélectionné par ces chemins | Non |

Le job applicatif n'est pas soumis à ce filtrage Terraform. Les tests des modules
`function`, `api-gateway` et `function-source` sont lancés séparément : Terraform
ne découvre pas leurs tests depuis la racine du stack. `.tflint.hcl` déclenche les
filtres qui le référencent ; ne pas supposer que tout fichier de configuration
relance tous les jobs.

Les plans de `runners` ne sont pas exécutés en PR : le rafraîchissement des
releases Helm lit des secrets Kubernetes, ce que le planner ne doit pas faire.
Le plan correspondant est visible dans le job d'apply.

## Authentification : fédération d'identité Workload Identity

Chaque job obtient un token OIDC GitHub échangé contre des credentials GCP
temporaires, sous les conditions du dépôt et de l'environnement déclarées dans
`infra/iam`. Aucune clé JSON de compte de service n'est stockée dans GitHub.

| Identité | Environnement GitHub | Usage |
| --- | --- | --- |
| `github-planner` | `<env>-plan` | Plans PR, lecture seule, sans verrou d'écriture du state |
| `github-terraform` | `<env>` | Apply et destroy, avec verrou du state |

Les rôles projet sont configurables par `planner_roles`/`deployer_roles`. Le code
IAM ajoute des rôles personnalisés pour les policies des ressources et des
attributions ciblées sur les secrets/comptes de service persistants. Le bootstrap
donne au planner la lecture des objets du bucket de sources. Consulter
`infra/iam/deployer-iam.tf`, `iam.tf`, `secrets.tf`, `runners.tf` et
`infra/bootstrap/functions.tf` pour le périmètre exact ; ne pas confondre accès
aux métadonnées/policies d'un secret et lecture de sa valeur.

Les environnements GitHub, variables `WIF_PROVIDER` et `DEPLOYER_SA`, reviewers et
restrictions de références sont déclarés dans `infra/iam`. Les règles réellement
appliquées dépendent de la configuration et des fonctionnalités GitHub du dépôt.
Les protections de branche se vérifient séparément dans les paramètres GitHub.

## Construction et déploiement des fonctions

Avant un plan/apply serverless, la CI installe les dépendances depuis le lockfile
du dépôt et lance `npm run build:functions`. Le module `function-source` crée le
ZIP et l'objet GCS ; `function` déploie depuis sa génération exacte.

Avant le destroy serverless, le même build fournit les fichiers nécessaires au
rafraîchissement de `archive_file` sur un runner neuf. Sans eux, la préparation
du destroy peut échouer avant toute suppression.

Le build CI utilise le lockfile du dépôt ; le manifeste livré à Cloud Build ne
contient pas de lockfile de déploiement. Dev et prd construisent chacun depuis
le commit sélectionné : ne pas assimiler cela à une promotion d'archives
identiques. Voir [les sources des fonctions](functions.md) et ADR-0009.

L'enregistrement des commandes Discord est une opération distincte, décrite
dans [son guide](discord-commands.md). `Deploy` n'exécute pas ce script. Les PR et
tests n'enregistrent aucune commande réelle.

## Runners auto-hébergés

`infra/runners` installe External Secrets et ARC sur le cluster de foundation
prd. External Secrets lit `arc-github-app` via Workload Identity for GKE et crée
le secret Kubernetes utilisé par ARC. Chaque job obtient un pod runner éphémère
sur le pool dédié ; les pods en attente contribuent au déclenchement de
l'autoscaling du pool.

### Affectation des jobs aux runners

- Pour les contrôles/PR : input `runner`, puis `vars.RUNNER_LABEL`, puis
  `ubuntu-latest` selon le job réutilisable.
- Les jobs d'apply/destroy orchestrés déclarent `ubuntu-latest` explicitement,
  pour rester indépendants de l'infrastructure modifiée.
- `changes` et `CI result`, ainsi que les tests applicatifs, utilisent un runner
  GitHub hébergé conformément à leurs fichiers de workflow.

`infra/runners` gère la variable de dépôt `RUNNER_LABEL`. Si elle pointe vers un
scale set indisponible, un contrôle peut rester en file. Pour un workflow qui
expose l'input, renseigner `runner=ubuntu-latest`. Le retrait de la variable est
une modification GitHub distincte à valider, pas un diagnostic sans effet.

### Application GitHub pour les runners

1. Créer une GitHub App et l'installer sur le seul dépôt concerné. Permissions
   de dépôt : administration lecture/écriture pour les runners, variables
   lecture/écriture, métadonnées lecture. Pas de webhook requis par ce parcours.
2. Après création du conteneur par `infra/iam` prd, préparer hors du dépôt un
   fichier accessible au seul propriétaire avec le schéma :

   ```json
   {"github_app_id":"<Client ID>","github_app_installation_id":"<installation ID>","github_app_private_key":"<contenu PEM>"}
   ```

3. Ajouter la version à Secret Manager sans afficher sa valeur :

   ```sh
   gcloud secrets versions add arc-github-app --project=cloud-pixelwar-prod \
     --data-file=/chemin/hors-du-depot/arc-github-app.json
   ```

4. Retirer les fichiers sensibles selon les règles de stockage sécurisé du poste.
   Ne pas les placer dans Git, les plans ou un ticket.

External Secrets lit la valeur dans le cluster. Les jobs runners la lisent en
mémoire pour obtenir un token d'installation GitHub de courte durée avec
`actions/create-github-app-token`. Cela ne donne pas aux fonctions applicatives
accès au secret.

## Vérification, concurrence et diagnostic

- Chaque apply/destroy est sérialisé par environnement **et stack**, sans
  annulation de l'opération en cours. Ce n'est pas un verrou global de release.
- Les plans PR utilisent `-lock=false` avec une identité de lecture. Si le state
  n'existe pas, `_plan.yml` peut produire un plan contre un state local vide ;
  le résumé le signale. Ce plan n'est pas une preuve de création de l'environnement.
- Les plans sont publiés dans le résumé du run. Ne pas publier un plan ou state
  brut contenant des informations sensibles ailleurs.
- Vérifier les approbations, références et runners du run avant de diagnostiquer
  un job en attente ; consulter Cloud Build pour les erreurs de build de fonction.
- Vérifier les plafonds de pools, `maxRunners`, quotas et budgets avant une montée
  en charge, selon [le guide GCP](gcp.md).

Pour les commandes de lancement, les prérequis, le retour arrière et les limites
du nettoyage, utiliser le [guide de déploiement](deployment.md).
