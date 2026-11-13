#!/usr/bin/env bash
# Run from infra/serverless after init. Read only: never move or delete state.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -f "$work/resources" "$work/error"; rmdir "$work"' EXIT
if ! terraform state list >"$work/resources" 2>"$work/error"; then
  if grep -q 'No state file was found' "$work/error"; then
    exit 0
  fi
  cat "$work/error" >&2
  exit 1
fi

if grep -Eq '^module\.api_gateway(\[|\.|$)' "$work/resources"; then
  echo '::error::Legacy Gateway resources are still owned by serverless. Stop and follow infra/gateway/README.md before applying; do not recreate or destroy them.' >&2
  exit 1
fi
