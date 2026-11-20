#!/usr/bin/env bash
# Vérifie qu'aucune ressource du projet n'est publique (SEC-01). Lecture seule.
#
# - Cloud Run (fonctions gen2 comprises) : aucun binding allUsers ni allAuthenticatedUsers,
#   sauf pour les services de PUBLIC_RUN_SERVICES (par défaut : frontend, ADR-0011).
# - Cloud Storage : aucun binding allUsers ni allAuthenticatedUsers, et
#   public_access_prevention = enforced. Seuls les buckets de staging gérés par Cloud Functions
#   (gcf-v2-sources-*, gcf-v2-uploads-*), hors Terraform, peuvent hériter de ce réglage.
#
# Usage : scripts/check-no-public.sh <project_id>
# Toute erreur de lecture fait échouer le contrôle : on ne conclut jamais « rien de public » sans avoir pu lire.
set -euo pipefail

project=${1:?Usage: $0 <project_id>}
# Vide (PUBLIC_RUN_SERVICES="") : aucune exception
read -r -a public_run_services <<<"${PUBLIC_RUN_SERVICES-frontend}"
public_members='allUsers|allAuthenticatedUsers'
managed_buckets='^gcf-v2-(sources|uploads)-'
violations=0

violation() {
  echo "::error::$*" >&2
  violations=$((violations + 1))
}

# Rôles accordés à allUsers ou allAuthenticatedUsers dans une policy IAM (JSON sur l'entrée)
public_roles() {
  jq -r --arg members "^($public_members)$" \
    '[.bindings[]? | select(any(.members[]?; test($members))) | .role] | unique | join(", ")'
}

is_public_run_service() {
  local name=$1 allowed
  # Tableau peut-être vide : forme compatible avec set -u sur bash 3.2 (macOS)
  for allowed in ${public_run_services[@]+"${public_run_services[@]}"}; do
    [[ $name == "$allowed" ]] && return 0
  done
  return 1
}

services=$(gcloud run services list --project="$project" --format='value(metadata.name,region)')
while read -r name region; do
  [[ -z $name ]] && continue
  roles=$(gcloud run services get-iam-policy "$name" --region="$region" --project="$project" --format=json | public_roles)
  if [[ -z $roles ]]; then
    echo "ok   run     $name ($region)"
  elif is_public_run_service "$name"; then
    echo "ok   run     $name ($region) : public autorisé ($roles)"
  else
    violation "Cloud Run $name ($region) est public : $roles"
  fi
done <<<"$services"

buckets=$(gcloud storage buckets list --project="$project" --format='value(name,public_access_prevention)')
while read -r name prevention; do
  [[ -z $name ]] && continue
  roles=$(gcloud storage buckets get-iam-policy "gs://$name" --format=json | public_roles)
  if [[ -n $roles ]]; then
    violation "Bucket $name est public : $roles"
  elif [[ $prevention != enforced && ! $name =~ $managed_buckets ]]; then
    violation "Bucket $name : public_access_prevention vaut '${prevention:-non défini}', attendu 'enforced'"
  else
    echo "ok   bucket  $name (public_access_prevention=${prevention:-non défini})"
  fi
done <<<"$buckets"

if ((violations > 0)); then
  echo "$violations ressource(s) publique(s) dans $project." >&2
  exit 1
fi
echo "Rien de public dans $project (hors exceptions documentées)."
