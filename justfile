# Raccourcis Terraform pour l'équipe (Windows, Linux, macOS).
# Lister les commandes : just
# Exemples : just plan dev    |    just apply dev serverless

set windows-shell := ["cmd.exe", "/c"]

# Si quelqu'un d'autre est en train d'appliquer, on attend au lieu d'échouer.
lock := "-lock-timeout=5m"

# Même version que TF_VERSION dans .github/workflows/_*.yml
tf_version := "1.17.0"

[private]
default:
    @just --list

# Prépare le poste : vérifie les outils, puis active les vérifications avant commit
# Si un outil manque, just s'arrête sur "could not find executable" : voir docs/outillage.md
setup:
    @echo terraform : {{ require('terraform') }}
    @echo tflint    : {{ require('tflint') }}
    @echo gitleaks  : {{ require('gitleaks') }}
    @echo lefthook  : {{ require('lefthook') }}
    @{{ if shell('terraform version -json') =~ ('"terraform_version":\s*"' + tf_version + '"') { "" } else { error("Terraform " + tf_version + " attendu, comme en CI : voir docs/outillage.md") } }}
    lefthook install
    tflint --init

# Montre ce que Terraform va changer, sans rien modifier
plan env stack="foundation": (_init env stack)
    terraform -chdir=infra/{{stack}} plan {{lock}} -var-file={{env}}.tfvars

# Crée / met à jour l'infra (demande confirmation)
apply env stack="foundation": (_init env stack)
    terraform -chdir=infra/{{stack}} apply {{lock}} -var-file={{env}}.tfvars

# Supprime l'infra (demande confirmation)
destroy env stack="foundation": (_init env stack)
    terraform -chdir=infra/{{stack}} destroy {{lock}} -var-file={{env}}.tfvars

# Vérifie le format et la validité, comme la CI
check stack="foundation":
    terraform -chdir=infra/{{stack}} fmt -check -recursive
    terraform -chdir=infra/{{stack}} init -backend=false -input=false
    terraform -chdir=infra/{{stack}} validate

# Formate tous les fichiers Terraform
fmt:
    terraform fmt -recursive infra

# Lance tflint sur tous les stacks (règles dans .tflint.hcl)
# Avec --recursive, tflint cherche la config dans chaque module : on lui donne un chemin absolu.
lint:
    tflint --recursive --chdir=infra --config="{{justfile_directory()}}/.tflint.hcl"

# Cherche des secrets dans les fichiers indexés
leaks:
    gitleaks git --pre-commit --staged --redact --no-banner

# Se branche sur le state de l'env choisi, pour ne jamais appliquer
# les variables de dev sur le state de prd (ou l'inverse).
[private]
_init env stack:
    @{{ if env =~ '^(dev|prd)$' { "" } else { error("env doit être dev ou prd") } }}
    terraform -chdir=infra/{{stack}} init -reconfigure -input=false -backend-config=backends/{{env}}.hcl
