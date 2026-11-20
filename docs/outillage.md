# Outillage du dépôt

## Préparer son poste

### 1. Installer les outils

Les contrôles d'infrastructure utilisent `just`, `terraform`, `tflint`, `gitleaks`
et `lefthook`. Installer **Terraform à la version déclarée par `TF_VERSION` dans
les workflows et `tf_version` dans le `justfile`**. Pour les autres outils,
utiliser une version compatible avec les configurations du dépôt et contrôler
les changements de comportement lors d'une mise à jour.

Windows (winget) :

```sh
winget install Casey.Just TerraformLinters.tflint Gitleaks.Gitleaks evilmartians.lefthook Hashicorp.Terraform
```

Le paquet winget de Terraform peut avoir une version de retard. Dans ce cas, prendre le zip sur [releases.hashicorp.com/terraform](https://releases.hashicorp.com/terraform/) et mettre `terraform.exe` dans le `PATH`.

macOS et Linux ([Homebrew](https://brew.sh/)) :

```sh
brew install just tflint gitleaks lefthook hashicorp/tap/terraform
```

Le Terraform de Homebrew core est bloqué en 1.5 : passer par `hashicorp/tap`. Sans Homebrew, chaque outil publie des binaires dans ses releases GitHub.

Selon l'opération, installer également :

| Usage | Outils |
| --- | --- |
| Application, build des fonctions et commandes Discord | Node.js 24 et npm, selon `app/package.json` |
| Émulateurs Firestore/Pub/Sub | Java 21 et outils npm du projet |
| Authentification et opérations GCP | Google Cloud CLI (`gcloud`) |
| GitHub et script d'application manuelle | Git, GitHub CLI (`gh`), `jq` et Bash |
| Diagnostic du cluster et des releases | `kubectl` et Helm ; le déploiement CI utilise les providers Terraform |
| Vérification des workflows | `actionlint`, en complément des tests CI |

Installer les outils depuis leurs distributions officielles. Les exemples
d'installation ci-dessus ne garantissent pas une version précise : vérifier les
versions avant `just setup` et suivre les [prérequis de test](testing.md).

### 2. Lancer `just setup`

Une fois par clone :

```sh
just setup
```

La commande vérifie que les outils sont présents et que Terraform est à la bonne version, puis active les vérifications avant commit (`lefthook install`) et télécharge les plugins tflint (`tflint --init`). Si un outil manque, elle s'arrête sur `could not find executable`.

`tflint --init` télécharge le plugin google depuis l'API GitHub. En cas d'erreur `rate limit exceeded`, relancer avec un token : `GITHUB_TOKEN=$(gh auth token) just setup`.

## Vérifications avant commit

`lefthook.yml` lance trois vérifications avant chaque commit :

- `terraform fmt -check` : en cas d'échec, lancer `just fmt` ;
- `just lint` : tflint sur tous les stacks, avec les règles de `.tflint.hcl` ;
- `just leaks` : gitleaks sur les fichiers indexés.

Le fichier seul ne fait rien : c'est `lefthook install` (lancé par `just setup`) qui écrit le hook dans `.git/hooks/pre-commit`. Pour tout vérifier sans commiter : `lefthook run pre-commit --all-files`.

Ces hooks se contournent (`git commit --no-verify`) : ils servent à voir les erreurs avant de pousser. La règle est imposée par la CI, qui lance aussi `terraform fmt` et tflint, et dont le contrôle `CI result` est requis pour merger.

## Lock des providers Terraform

Chaque stack versionne son `.terraform.lock.hcl`. Il contient les empreintes des providers pour toutes les plateformes de l'équipe et de la CI. Sans elles, chaque `init` sur un autre OS modifie le fichier.

À chaque ajout ou montée de version d'un provider, régénérer le lock du stack concerné :

```sh
terraform -chdir=infra/<stack> init -backend=false
terraform -chdir=infra/<stack> providers lock -platform=linux_amd64 -platform=windows_amd64 -platform=darwin_arm64 -platform=darwin_amd64
```

## Fichiers ignorés

Le `.gitignore` exclut le state et les plans Terraform, les fichiers `.env`, les artefacts Node.js et les clés de service account (`*-key.json`, `credentials*.json`, etc.). Les autres fichiers `.json` (par exemple `package.json` ou `firebase.json`) restent versionnés. gitleaks rattrape les secrets qui passeraient à travers.

## Pull requests

Le template `.github/pull_request_template.md` reprend la Definition of Done. `.github/CODEOWNERS` demande automatiquement la review des membres de l'équipe.
