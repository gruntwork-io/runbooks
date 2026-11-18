#!/usr/bin/env bash
set -euo pipefail

echo "AZURE_AUTH_TYPE=${AZURE_AUTH_TYPE:-}"
echo "AZURE_PRINCIPAL_NAME=${AZURE_PRINCIPAL_NAME:-}"
echo "AZURE_PRINCIPAL_TYPE=${AZURE_PRINCIPAL_TYPE:-}"
echo "ARM_TENANT_ID=${ARM_TENANT_ID:-}"
echo "ARM_SUBSCRIPTION_ID=${ARM_SUBSCRIPTION_ID:-}"
echo "AZURE_CONFIG_DIR=${AZURE_CONFIG_DIR:-}"

if ! command -v az >/dev/null 2>&1; then
  echo "az isn't installed; skipping az account show"
  exit 0
fi

az account show --only-show-errors -o table
