#!/usr/bin/env bash
#
# Check Google Cloud authentication.
#
#   exit 0  credentials are present AND verified against Google
#   exit 2  credentials are present and well-formed, but could not be verified
#           (no network, no curl/jq/openssl, no gcloud)
#   exit 1  no usable credentials in the session environment
#
set -euo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

echo "Checking Google Cloud authentication..."

creds="${GOOGLE_APPLICATION_CREDENTIALS:-}"
token="${GOOGLE_OAUTH_ACCESS_TOKEN:-${CLOUDSDK_AUTH_ACCESS_TOKEN:-}}"
project="${CLOUDSDK_CORE_PROJECT:-${GOOGLE_CLOUD_PROJECT:-${GOOGLE_PROJECT:-}}}"

# --- 1. Is there a credential at all? ----------------------------------------

if [ -z "$creds" ] && [ -z "$token" ]; then
  echo "No Google Cloud credentials found in the session environment."
  echo "Expected GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_OAUTH_ACCESS_TOKEN, or"
  echo "CLOUDSDK_AUTH_ACCESS_TOKEN. Authenticate with the <GoogleAuth> block first."
  exit 1
fi

# --- 2. Is the credential file structurally sound? ---------------------------

if [ -n "$creds" ]; then
  if [ ! -r "$creds" ]; then
    echo "GOOGLE_APPLICATION_CREDENTIALS points at a file that cannot be read:"
    echo "  $creds"
    exit 1
  fi

  if ! have jq; then
    echo "Credential file present at $creds, but jq is not installed so it"
    echo "cannot be inspected."
    exit 2
  fi

  cred_type=$(jq -r '.type // "unknown"' "$creds" 2>/dev/null || echo "unparseable")
  case "$cred_type" in
    service_account | authorized_user | external_account | impersonated_service_account)
      echo "Credential file:  $creds"
      echo "Credential type:  $cred_type"
      ;;
    unparseable)
      echo "GOOGLE_APPLICATION_CREDENTIALS is not valid JSON: $creds"
      exit 1
      ;;
    *)
      echo "GOOGLE_APPLICATION_CREDENTIALS has an unrecognized type: $cred_type"
      exit 1
      ;;
  esac
else
  echo "Credential:       ambient OAuth access token from the environment"
fi

echo "Project:          ${project:-<unset>}"
echo "Account:          ${CLOUDSDK_CORE_ACCOUNT:-<unset>}"

# --- 3. Can we prove it works? -----------------------------------------------

if ! have curl || ! have jq; then
  echo "Credentials look well-formed, but curl and jq are needed to verify them"
  echo "against Google's APIs."
  exit 2
fi

# Resolve an access token the cheap way. Anything more elaborate belongs in
# scripts/verify-auth.sh, which does the full JWT/refresh exchange.
#
# When a credentials file was exported we must resolve THROUGH it
# (`gcloud auth application-default print-access-token` honours
# GOOGLE_APPLICATION_CREDENTIALS); plain `gcloud auth print-access-token` uses
# gcloud's own login and would happily report success for a different identity.
if [ -z "$token" ] && have gcloud; then
  if [ -n "$creds" ]; then
    token=$(gcloud auth application-default print-access-token 2>/dev/null || true)
  else
    token=$(gcloud auth print-access-token 2>/dev/null || true)
  fi
fi

if [ -z "$token" ]; then
  echo "Credentials look well-formed, but no access token could be obtained"
  echo "without the gcloud CLI. Run the 'Verify Google Cloud Identity' command"
  echo "above for a full token exchange."
  exit 2
fi

# POST body, read from stdin — never argv, never the URL. A token on curl's
# command line is readable by every other user on the machine (`ps auxww`,
# /proc/<pid>/cmdline) for its full lifetime.
info=$(printf 'access_token=%s' "$token" |
  curl -sS --max-time 20 --data @- "https://oauth2.googleapis.com/tokeninfo" || true)

if [ -z "$info" ]; then
  echo "Could not reach https://oauth2.googleapis.com to verify the token."
  exit 2
fi

if [ "$(echo "$info" | jq -r 'has("error") or has("error_description")' 2>/dev/null)" = "true" ]; then
  echo "Google rejected the access token:"
  echo "$info" | jq -r '.error_description // .error'
  exit 1
fi

principal=$(echo "$info" | jq -r '.email // .sub // .azp // "unknown"')
echo "Successfully authenticated to Google Cloud as $principal"
exit 0
