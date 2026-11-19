#!/usr/bin/env bash
set -uo pipefail

fail() { echo "FAIL: $*"; exit 1; }

[[ -n "${AZURE_TENANT_ID:-}" ]] || fail "AZURE_TENANT_ID is not set"
# With the Azure CLI's sign-in, azurerm gets the tenant from the CLI: an ARM_TENANT_ID would make
# the azurerm backend pass both --tenant and --subscription to az, which refuses them.
if [[ "${ARM_USE_CLI:-}" == "true" ]]; then
  [[ -z "${ARM_TENANT_ID:-}" ]] || fail "ARM_TENANT_ID is set with ARM_USE_CLI"
else
  [[ "${ARM_TENANT_ID:-}" == "${AZURE_TENANT_ID}" ]] || fail "ARM_TENANT_ID doesn't match AZURE_TENANT_ID"
fi
[[ "${AZURE_SUBSCRIPTION_ID:-}" == "${ARM_SUBSCRIPTION_ID:-}" ]] || fail "AZURE_SUBSCRIPTION_ID doesn't match ARM_SUBSCRIPTION_ID"

case "${AZURE_AUTH_TYPE:-}" in
  cli | device_code)
    [[ "${ARM_USE_CLI:-}" == "true" ]] || fail "ARM_USE_CLI should be true for an Azure CLI sign-in"
    [[ -d "${AZURE_CONFIG_DIR:-}" ]] || fail "AZURE_CONFIG_DIR is not a directory"
    [[ -z "${ARM_CLIENT_SECRET:-}" ]] || fail "a client secret leaked into an Azure CLI step"
    ;;
  service_principal)
    [[ -n "${ARM_CLIENT_ID:-}" ]] || fail "ARM_CLIENT_ID is not set"
    [[ -n "${ARM_CLIENT_SECRET:-}${AZURE_CLIENT_CERTIFICATE_PATH:-}" ]] ||
      fail "no client secret or certificate"
    ;;
  *)
    fail "unexpected AZURE_AUTH_TYPE '${AZURE_AUTH_TYPE:-}'"
    ;;
esac

echo "Azure variables OK (${AZURE_AUTH_TYPE}, tenant ${AZURE_TENANT_ID})"
