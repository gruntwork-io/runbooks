#!/usr/bin/env bash
#
# List Google Cloud resources using the credentials <GoogleAuth> injected.
#
# Prefers the real gcloud/gsutil commands when they are installed, and falls
# back to the equivalent REST calls (plain curl) when they are not, so the demo
# still does something useful on a machine without the Cloud SDK.
#
set -euo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

project="${CLOUDSDK_CORE_PROJECT:-${GOOGLE_CLOUD_PROJECT:-${GOOGLE_PROJECT:-}}}"
region="${CLOUDSDK_COMPUTE_REGION:-${GOOGLE_CLOUD_REGION:-us-central1}}"

if [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] &&
  [ -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ] &&
  [ -z "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: no Google Cloud credentials in the session environment."
  echo "Authenticate with the <GoogleAuth> block above first."
  exit 1
fi

# Resolve an access token for the REST fallbacks. Empty when we cannot get one
# without gcloud -- every REST section below degrades to a hint in that case.
access_token=""
if [ -n "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]; then
  access_token="$GOOGLE_OAUTH_ACCESS_TOKEN"
elif [ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ]; then
  access_token="$CLOUDSDK_AUTH_ACCESS_TOKEN"
elif have gcloud; then
  access_token=$(gcloud auth print-access-token 2>/dev/null || true)
fi

# GET a Google API endpoint with the resolved access token. Returns non-zero
# when we have nothing to authenticate with, so callers can print a hint.
#
# The Authorization header is fed to curl through a config file on STDIN rather
# than `-H`: anything in argv is readable by every other user on the machine
# (`ps auxww`, /proc/<pid>/cmdline) for the token's whole ~1h lifetime.
rest_get() {
  if [ -z "$access_token" ] || ! have curl || ! have jq; then
    return 1
  fi
  printf 'header = "Authorization: Bearer %s"\n' "$access_token" |
    curl -sS --config - "$1"
}

no_rest="  (skipped: needs the gcloud CLI, or curl + jq and an access token)"

echo "=== Google Cloud Account Information ==="
echo "Project: ${project:-<unset>}"
echo "Account: ${CLOUDSDK_CORE_ACCOUNT:-<unset>}"
echo "Region:  ${region}"
if have gcloud; then
  gcloud config list --format="yaml" 2>/dev/null || echo "  (gcloud config unavailable)"
  gcloud auth list --format="value(account,status)" 2>/dev/null || true
else
  echo "  (gcloud CLI not installed -- reporting the session environment only)"
fi

echo ""
echo "=== Cloud Storage Buckets ==="
if have gcloud; then
  gcloud storage buckets list --format="table(name,location,storageClass)" 2>/dev/null ||
    gsutil ls 2>/dev/null ||
    echo "No buckets found or insufficient permissions"
elif have gsutil; then
  gsutil ls || echo "No buckets found or insufficient permissions"
elif ! json=$(rest_get "https://storage.googleapis.com/storage/v1/b?project=${project}"); then
  echo "$no_rest"
else
  echo "$json" | jq -r 'if .error then "  Error: " + .error.message
           elif ((.items // []) | length) == 0 then "  No buckets found"
           else (.items[] | "  " + .name + "  (" + .location + ", " + .storageClass + ")") end' 2>/dev/null ||
    echo "  No buckets found or insufficient permissions"
fi

echo ""
echo "=== Compute Engine Instances (region: ${region}) ==="
if have gcloud; then
  gcloud compute instances list --filter="zone~${region}" \
    --format="table(name,zone,machineType,status)" 2>/dev/null ||
    echo "No instances found or insufficient permissions"
elif ! json=$(rest_get "https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/instances"); then
  echo "$no_rest"
else
  echo "$json" | jq -r 'if .error then "  Error: " + .error.message
           else ([.items[]?.instances[]?] | if length == 0 then "  No instances found"
           else (.[] | "  " + .name + "  " + (.zone | split("/") | last) + "  " + .status) end) end' 2>/dev/null ||
    echo "  No instances found or insufficient permissions"
fi

echo ""
echo "=== Enabled Services (first 10) ==="
if have gcloud; then
  gcloud services list --enabled --limit=10 --format="value(config.name)" 2>/dev/null ||
    echo "Could not list enabled services"
elif ! json=$(rest_get "https://serviceusage.googleapis.com/v1/projects/${project}/services?filter=state:ENABLED&pageSize=10"); then
  echo "$no_rest"
else
  echo "$json" | jq -r 'if .error then "  Error: " + .error.message
           else (.services[]? | "  " + .config.name) end' 2>/dev/null ||
    echo "  Could not list enabled services"
fi

echo ""
echo "Done!"
echo "RUNBOOK_OUTPUT:google_project=${project}"
