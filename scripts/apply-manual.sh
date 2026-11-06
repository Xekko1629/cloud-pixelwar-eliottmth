#!/usr/bin/env bash
# Applique les stacks que la CI n'applique jamais : iam, puis access, environnement par environnement.
# Chaque plan est affiché, puis appliqué seulement après confirmation ; une destruction exige de taper "destroy".
#
# Usage : scripts/apply-manual.sh [dev|prd|all] [iam|access|all]
#   scripts/apply-manual.sh              # iam dev, access dev, iam prd, access prd
#   scripts/apply-manual.sh prd access   # access prd seulement
set -euo pipefail

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

case "${1:-all}" in
  dev | prd) envs=("$1") ;;
  all) envs=(dev prd) ;;
  *) usage ;;
esac

case "${2:-all}" in
  iam | access) stacks=("$2") ;;
  all) stacks=(iam access) ;; # iam d'abord : il active les APIs utilisées par access
  *) usage ;;
esac

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

ask() {
  local answer
  printf '%s ' "$1"
  read -r answer || answer=""
  [[ $answer == "$2" ]]
}

for tool in terraform gcloud gh jq git; do
  command -v "$tool" >/dev/null || { red "Outil manquant : $tool (voir docs/outillage.md)"; exit 1; }
done

root=$(git rev-parse --show-toplevel)

# Terraform utilise les identifiants applicatifs de gcloud, pas ceux de la CLI
if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  red "Pas d'identifiants applicatifs : lancer d'abord 'gcloud auth application-default login'."
  exit 1
fi

# Le provider github de iam a besoin d'un token d'admin du dépôt
if [[ -z ${GITHUB_TOKEN:-} ]]; then
  GITHUB_TOKEN=$(gh auth token)
  export GITHUB_TOKEN
fi

# Ce qui est appliqué doit être ce qui a été relu et mergé
git -C "$root" fetch --quiet origin prod
if [[ $(git -C "$root" rev-parse HEAD) != $(git -C "$root" rev-parse origin/prod) ]]; then
  red "HEAD n'est pas origin/prod ($(git -C "$root" branch --show-current)) : le code appliqué n'est pas celui de prod."
  ask "Continuer quand même ? [y/N]" y || exit 1
fi

# Les plans contiennent des emails : jamais dans le dépôt, supprimés à la fin
plans=$(mktemp -d)
trap 'rm -rf "$plans"' EXIT

for env in "${envs[@]}"; do
  for stack in "${stacks[@]}"; do
    dir="$root/infra/$stack"
    plan="$plans/$stack-$env.tfplan"
    bold "=== $stack ($env)"

    terraform -chdir="$dir" init -reconfigure -input=false -backend-config="backends/$env.hcl" >/dev/null

    status=0
    terraform -chdir="$dir" plan -input=false -lock-timeout=5m -var-file="$env.tfvars" \
      -detailed-exitcode -out="$plan" || status=$?
    case $status in
      0) echo "Aucun changement."; continue ;;
      2) ;;
      *) red "Plan en échec pour $stack ($env)."; exit 1 ;;
    esac

    destroyed=$(terraform -chdir="$dir" show -json "$plan" |
      jq -r '(.resource_changes // [])[] | select(.change.actions | index("delete")) | .address')
    if [[ -n $destroyed ]]; then
      red "Ce plan DÉTRUIT ou REMPLACE :"
      sed 's/^/  - /' <<<"$destroyed"
      ask "Taper 'destroy' pour appliquer quand même :" destroy || { echo "Ignoré."; continue; }
    else
      ask "Appliquer ce plan sur $stack ($env) ? [y/N]" y || { echo "Ignoré."; continue; }
    fi

    terraform -chdir="$dir" apply -input=false -lock-timeout=5m "$plan"
  done
done

bold "Terminé."
