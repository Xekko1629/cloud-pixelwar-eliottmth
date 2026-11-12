# Installation et déploiement

## Objectif et portée

Ce guide couvre la création d'un environnement vide, sa mise à jour et son
retrait. `dev` et `prd` désignent les environnements GCP ; `prod` est la branche
Git principale. Les commandes sont des procédures à exécuter avec les droits et
validations nécessaires, pas un relevé d'opérations réalisées.

Les bibliothèques `app/shared` et les outils de développement ne se déploient pas
séparément : les premières sont intégrées aux archives des fonctions, les seconds
s'exécutent sur le poste ou dans la CI. Pour ajouter un composant applicatif,
utiliser le [contrat des fonctions](functions.md), puis sa procédure spécifique.

## Prérequis et identités

- Checkout de la version à installer, outils de [préparation du poste](outillage.md).
- Projets GCP sous un compte de facturation actif, avec quotas suffisants.
- Identité humaine autorisée à créer les projets ou à les administrer, gérer
  leurs APIs/IAM et buckets, rattacher la facturation et créer les budgets.
- Droits d'administration du dépôt pour les environnements GitHub et un token
  utilisable par le provider `integrations/github`. Ne pas confondre ces droits
  avec le seul droit de pousser une branche.
- Accès aux applications Discord des environnements concernés et aux données
  nécessaires pour alimenter les secrets hors Terraform.

La CI utilise WIF, jamais une clé JSON de compte de service. Les rôles exacts des
identités de CI sont configurés dans `infra/iam` ; les attributions humaines
dans `infra/access`. Ne pas augmenter des rôles pour contourner une erreur sans
identifier la permission et la ressource concernées.

## Configuration et dépendances des stacks

| Stack | Contenu | Application | Prérequis | Destroy automatisé |
| --- | --- | --- | --- | --- |
| `iam` | APIs, bucket de state adopté, WIF, planner/deployer, environnements GitHub, budgets et secrets | Manuelle | Projets, facturation, bucket de state, administration GitHub | Non |
| `access` | Attributions humaines GCP et lecture des secrets dev | Manuelle | `iam` du même environnement | Non |
| `foundation` | Réseau et cluster GKE conditionnel | CI | `iam` | Oui |
| `bootstrap` | Sources des fonctions, registre interne et identité de build | CI | `iam` | Non |
| `serverless` | Archives, fonctions et intégrations déclarées | CI | `foundation`, `bootstrap`, versions de secrets utilisées | Oui |
| `runners` | External Secrets, ARC et routage des jobs | CI, prd | Cluster foundation, identités et secret GitHub App | Oui, prd |

Avant toute commande, contrôler les `<env>.tfvars` et `backends/<env>.hcl` de
chaque stack. Pour une nouvelle installation utilisant d'autres projets ou un
autre dépôt, adapter tous les identifiants et références concernés avant review.
Les projets/buckets de référence sont décrits dans [GCP](gcp.md) et les fichiers
de backend ; le nom d'un bucket historique n'est pas l'ID du projet.

## Installation initiale

### 1. Préparer le dépôt et les accès locaux

Les workflows doivent être accessibles sur la branche par défaut pour permettre
un lancement manuel. Contribuer et publier le code selon le [GitFlow](gitflow.md).

Authentifier séparément la CLI GCP, les identifiants applicatifs utilisés par
Terraform et la CLI GitHub :

```sh
gcloud auth login
gcloud auth application-default login
gh auth login
```

Ne pas afficher les jetons. Vérifier le compte actif, le dépôt visé et les projets
avant de continuer. Les exemples supposent Bash et un terminal placé à la racine
du dépôt. Renseigner les variables depuis les configurations de l'installation
et remplacer les chemins d'exemple par des emplacements accessibles hors du
dépôt. Aucune variable ne sélectionne implicitement un environnement sûr.

### 2. Créer les projets et rattacher la facturation

Pour **chaque** environnement, définir `PROJECT_ID`, `STATE_BUCKET` et
`BILLING_ACCOUNT` avec les valeurs approuvées. Les projets et leur rattachement
ne sont pas créés par les stacks de ce dépôt.

Uniquement pour un projet inexistant :

```sh
gcloud projects create "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
```

Si le projet existe, vérifier son rattachement au lieu de le recréer. Activer le
minimum nécessaire au premier accès et au backend :

```sh
gcloud services enable serviceusage.googleapis.com \
  cloudresourcemanager.googleapis.com storage.googleapis.com --project="$PROJECT_ID"
gcloud auth application-default set-quota-project "$PROJECT_ID"
```

`infra/iam/apis.tf` prend en charge les APIs gérées par Terraform. Un budget est
une alerte, pas un arrêt automatique de la consommation.

### 3. Créer le bucket de state avant le premier init distant

Le backend ne peut pas créer son propre bucket. `infra/iam/state.tf` adopte un
bucket existant par bloc `import` ; il ne faut pas commencer par un init GCS vers
un bucket absent.

Vérifier d'abord si `STATE_BUCKET` existe et appartient au projet choisi. Seulement
si le bucket est absent, créer un bucket privé dont les propriétés correspondent
au code `state.tf` :

```sh
gcloud storage buckets create "gs://$STATE_BUCKET" --project="$PROJECT_ID" \
  --location=EU --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$STATE_BUCKET" --versioning
```

Lors du plan IAM, vérifier son adoption, le versioning, la protection d'accès
public et la rétention de suppression douce. Le bucket est partagé par les
stacks de l'environnement, avec un préfixe distinct par stack. Utiliser le
workspace Terraform `default` ; ne pas créer des workspaces pour séparer dev/prd.

### 4. Appliquer IAM, puis les accès humains

Depuis la racine, définir `ENV=dev` ou `ENV=prd`. Dans un terminal sans traçage
shell, injecter le token GitHub sans l'imprimer :

```sh
set +x
GITHUB_TOKEN=$(gh auth token) || exit 1
export GITHUB_TOKEN
terraform -chdir=infra/iam init -reconfigure -backend-config="backends/$ENV.hcl"
```

**Choisir le mode d'installation des secrets avant le plan :**

- environnement vide : `import_application_secrets=false` ; créer les conteneurs ;
- adoption de secrets existants : `true` exige les secrets concernés et leurs
  droits de lecture de métadonnées. Examiner les imports, sans recréer les valeurs.

Le fichier `infra/iam/dev.tfvars` active l'adoption. Pour une installation dev
vide, désactiver cette option dans la configuration approuvée ou la remplacer
explicitement lors de la génération du plan :

```sh
# Installation vide seulement ; stocker le plan hors du dépôt.
terraform -chdir=infra/iam plan -var-file="$ENV.tfvars" \
  -var=import_application_secrets=false -out=/chemin/hors-du-depot/iam.tfplan
terraform -chdir=infra/iam apply /chemin/hors-du-depot/iam.tfplan
```

N'appliquer qu'après lecture et validation du plan, notamment de l'import du
bucket et des droits. Pour une adoption, utiliser le plan avec l'option appropriée
plutôt que copier la commande d'installation vide. Ne pas mélanger des ressources
déjà gérées dans plusieurs states.

Appliquer ensuite `access` selon son [guide](../infra/access/README.md), puis
retirer `GITHUB_TOKEN` du terminal. Vérifier dans GitHub les environnements
`dev`, `dev-plan`, `prd`, `prd-plan`, leurs variables `WIF_PROVIDER`/`DEPLOYER_SA`
et les restrictions configurées. La possibilité d'appliquer les protections
dépend aussi des fonctionnalités GitHub disponibles pour le dépôt.

Pour les mises à jour manuelles sur backends existants, `just manual` ou
`scripts/apply-manual.sh <env> <stack>` présente les plans et demande confirmation.
Ce script ne remplace pas la création initiale du bucket et ne choisit pas le
mode d'adoption des secrets à la place de l'opérateur.

### 5. Alimenter les secrets et configurer les applications externes

- Créer une application Discord par environnement ; utiliser ses propres
  identifiants et sa clé publique pour ce même environnement.
- Ajouter uniquement les valeurs nécessaires aux composants à déployer, selon
  le [guide Secret Manager](../infra/iam/SECRETS.md). Référencer des versions
  numériques activées ; aucun secret dans Git, les plans ou les logs.
- Pour les runners prd, créer et installer une GitHub App sur le dépôt, avec
  permissions de runners et de variables. Ajouter la valeur du secret
  `arc-github-app` après création de son conteneur : voir [CI/CD](ci.md#application-github-pour-les-runners).
- Pour une intégration OAuth, configurer les URI de redirection avec les URLs
  de l'environnement déployé et les restrictions du composant concerné.

### 6. Déployer dev par la CI

Vérifier la CI et les plans de la version choisie, puis faire valider l'opération.
Le lancement manuel applique `foundation` et `bootstrap` en dev, puis `serverless`.
Il peut créer du réseau ou un cluster selon les variables : ce n'est pas une
commande de déploiement d'une seule fonction.

Dans GitHub : **Actions → Deploy → Run workflow**, choisir la référence approuvée
et `runner=ubuntu-latest` pour ne pas dépendre des runners auto-hébergés.
Exemple depuis la branche intégrée, à exécuter seulement après accord :

```sh
gh workflow run deploy.yml --repo Xekko1629/cloud-pixelwar-eliottmth \
  --ref prod -f runner=ubuntu-latest
```

Les jobs prd doivent être ignorés lors de ce lancement manuel. Ne pas pousser
de tag `v*` pour un essai limité à dev. La séquence des jobs est décrite dans
[CI/CD](ci.md).

### 7. Vérifier et configurer le callback Discord

Après réussite du run, initialiser le backend **dev** pour lire ses outputs :

```sh
terraform -chdir=infra/serverless init -reconfigure -backend-config=backends/dev.hcl
terraform -chdir=infra/serverless output
```

Contrôler les URLs, les ressources créées et les attributions IAM, puis effectuer
les vérifications du composant : [sonde Discord hello](discord-hello.md),
[routage Gateway](../infra/serverless/modules/api-gateway/README.md#vérification-sur-un-environnement-déployé),
[observabilité](observability.md#vérification-en-environnement-gcp).

Un output absent ou nul n'est pas une URL utilisable : vérifier la configuration
et les logs avant de continuer. Configurer le callback dans l'application
Discord correspondante et enregistrer les commandes avec la
[procédure dédiée](discord-commands.md). Ces actions externes ne sont pas
exécutées par `Deploy` ; ne pas confondre un déploiement réussi, un catalogue
enregistré et une commande métier fonctionnelle.

## Mise à jour et déploiement prd

1. Modifier la configuration ou le code dans une branche, avec tests et PR vers
   `prod`. Lire les plans et les effets de suppression/remplacement.
2. Si `iam` ou `access` change, appliquer manuellement les prérequis validés avant
   le déploiement CI des composants qui en dépendent.
3. Vérifier la version en dev et les quotas, secrets et accès prd nécessaires.
4. Après accord de release, créer et pousser un nouveau tag signé sur le commit
   choisi de `prod`, selon le [GitFlow](gitflow.md). **Le push du tag déclenche
   le déploiement** dev puis prd ; il ne crée pas une simple référence passive.
5. Suivre les approbations GitHub configurées et les plans d'apply de chaque stack.
   Vérifier ensuite les services prd et les intégrations externes correspondantes.

Chaque environnement construit les sources depuis le commit de release selon
ADR-0009 ; les archives ne sont pas promues par copie entre projets. Cloud Build
installe les dépendances depuis le manifeste généré, sans lockfile de déploiement.

## Diagnostic et reprise

| Symptôme | Vérification |
| --- | --- |
| Init GCS impossible | Existence du bucket, projet, identité ADC, droits et configuration du backend |
| Import de secret en échec | Mode vide/adoption, existence des ressources, éventuelle gestion dans un autre state |
| Plan PR refusé | Variables de l'environnement `<env>-plan`, WIF, droits de lecture et bootstrap |
| Build Google en échec | Logs Cloud Build, identité `function-builder`, lecture des sources, registre, dépendances et point d'entrée |
| Job bloqué en attente | Approbation de l'environnement ou runner indisponible ; renseigner le runner hébergé pour les contrôles |
| Backend HTTP refusé | Identité invoker, audience, ingress, état de la fonction et secret activé |
| Callback Discord refusé | Application/clé publique correspondantes, corps brut, signature, chemin et délai de réponse |

Ne pas relancer un apply ou un enregistrement en boucle. Lire le plan, les logs
et l'état effectif après une interruption. Ne pas forcer un déverrouillage de
state tant qu'une autre opération peut être active.

## Retour arrière

Pour une configuration, préparer une correction versionnée, lire son plan et
suivre le même processus de déploiement. Vérifier la compatibilité des données,
des secrets référencés et des règles IAM avant tout retour à un ancien code.

Le workflow ne propose pas de sélection de manifeste de rollback. Un retour à
des sources antérieures passe par une nouvelle révision approuvée et, pour prd,
une nouvelle release signée : ne pas déplacer un tag publié. Une reconstruction
sans lockfile ne garantit pas les mêmes dépendances transitives ni la même image.
Le versioning des buckets et du state n'est pas un mécanisme automatique de
rollback applicatif ; toute restauration de state exige un diagnostic distinct.

## Suppression

Le workflow `Destroy` est manuel, avec environnement et confirmation saisie :

1. Relever les intégrations externes actives. Retirer/remplacer les callbacks et
   commandes concernés avant de supprimer leurs backends.
2. Dans **Actions → Destroy → Run workflow**, sélectionner la version relue,
   `dev` ou `prd`, puis saisir exactement le même nom dans `confirm`.
3. Après validation explicite, lancer et vérifier les suppressions : `serverless`
   et `runners` (prd) en parallèle, puis `foundation`.
4. Contrôler les restes effectifs : fonctions, clusters, disques, IP, équilibreurs,
   objets et ressources externes. Ne pas considérer un run vert comme un bilan
   automatique d'absence de coût.

`iam`, `access` et `bootstrap` sont conservés, dont secrets, archives versionnées,
registre et states. Leur stockage et les versions supprimées peuvent être facturés.
Le nettoyage complet est une opération distincte : sauvegardes, vérification des
besoins de reprise, retrait relu des protections et purge approuvée des données,
versions et rétentions. **Ne pas supprimer le bucket contenant les states avant
la fin de la gestion des ressources qu'ils décrivent.** Le workflow ne supprime
pas les projets GCP, les applications Discord ni la GitHub App.
