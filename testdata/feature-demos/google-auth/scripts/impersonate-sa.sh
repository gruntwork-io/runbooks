#!/usr/bin/env bash
#
# Mint a short-lived access token for another service account -- the Google
# analogue of `aws sts assume-role`.
#
# The resulting token is written to $RUNBOOK_OUTPUT so a downstream
# <GoogleAuth detectCredentials={[{ block: 'impersonate-service-account' }]} />
# block can pick it up. It is never echoed to stdout.
#
# Uses `gcloud auth print-access-token --impersonate-service-account` when the
# Cloud SDK is installed, and the IAM Credentials REST API (plain curl) when it
# is not.
#
set -euo pipefail

TARGET_SA="{{ .inputs.TargetServiceAccount }}"
LIFETIME="{{ .inputs.Lifetime }}"

CLOUD_PLATFORM_SCOPE="https://www.googleapis.com/auth/cloud-platform"
TOKEN_URI="https://oauth2.googleapis.com/token"
IAM_CREDENTIALS_URI="https://iamcredentials.googleapis.com/v1"

have() { command -v "$1" >/dev/null 2>&1; }

for tool in curl jq; do
  if ! have "$tool"; then
    echo "ERROR: $tool is required to impersonate a service account"
    exit 1
  fi
done

if [ -z "$TARGET_SA" ]; then
  echo "ERROR: no target service account provided"
  exit 1
fi

project="${CLOUDSDK_CORE_PROJECT:-${GOOGLE_CLOUD_PROJECT:-${GOOGLE_PROJECT:-}}}"

echo "Attempting to impersonate: $TARGET_SA"
echo "Source project:            ${project:-<unset>}"
echo "Requested lifetime:        ${LIFETIME}s"

# --- Source credential -------------------------------------------------------

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

token_from_authorized_user() {
  local creds="$1"
  # The body is piped in on STDIN. --data-urlencode would put client_secret and
  # refresh_token on curl's command line, where any other user on the machine
  # can read them out of `ps auxww` (or /proc/<pid>/cmdline).
  jq -r '"grant_type=refresh_token"
         + "&client_id=" + (.client_id | @uri)
         + "&client_secret=" + (.client_secret | @uri)
         + "&refresh_token=" + (.refresh_token | @uri)' "$creds" |
    curl -sS -X POST --data @- "$TOKEN_URI" |
    jq -r '.access_token // empty'
}

token_from_service_account() {
  local creds="$1"
  have openssl || return 1

  local now exp header claim signing_input key_file sig assertion
  now=$(date +%s)
  exp=$((now + 3600))
  header='{"alg":"RS256","typ":"JWT"}'
  claim=$(jq -nc \
    --arg iss "$(jq -r '.client_email' "$creds")" \
    --arg scope "$CLOUD_PLATFORM_SCOPE" \
    --arg aud "$TOKEN_URI" \
    --argjson iat "$now" \
    --argjson exp "$exp" \
    '{iss: $iss, scope: $scope, aud: $aud, iat: $iat, exp: $exp}')

  signing_input="$(printf '%s' "$header" | b64url).$(printf '%s' "$claim" | b64url)"

  key_file=$(mktemp)
  chmod 600 "$key_file"
  # shellcheck disable=SC2064
  trap "rm -f '$key_file'" RETURN
  jq -r '.private_key' "$creds" >"$key_file"

  sig=$(printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$key_file" | b64url)
  assertion="${signing_input}.${sig}"

  # STDIN again: the signed assertion is a bearer-equivalent for its lifetime,
  # so it must not land in argv. It is base64url, so no escaping is needed.
  printf 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=%s' "$assertion" |
    curl -sS -X POST --data @- "$TOKEN_URI" |
    jq -r '.access_token // empty'
}

source_access_token() {
  if [ -n "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]; then
    printf '%s' "$GOOGLE_OAUTH_ACCESS_TOKEN"
    return 0
  fi
  if [ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ]; then
    printf '%s' "$CLOUDSDK_AUTH_ACCESS_TOKEN"
    return 0
  fi

  # Once a credentials file is exported we mint from THAT file and nothing
  # else -- falling back to gcloud's own login would impersonate from a
  # different source identity than the runbook authenticated with.
  local creds="${GOOGLE_APPLICATION_CREDENTIALS:-}"
  if [ -n "$creds" ]; then
    [ -r "$creds" ] || return 1
    local cred_type token
    cred_type=$(jq -r '.type // "unknown"' "$creds")
    case "$cred_type" in
      authorized_user) token=$(token_from_authorized_user "$creds") ;;
      service_account) token=$(token_from_service_account "$creds") ;;
      *)
        # `gcloud auth application-default print-access-token` resolves ADC, so
        # it honours GOOGLE_APPLICATION_CREDENTIALS.
        if have gcloud; then
          token=$(gcloud auth application-default print-access-token 2>/dev/null || true)
        else
          token=""
        fi
        ;;
    esac
    [ -n "$token" ] || return 1
    printf '%s' "$token"
    return 0
  fi

  if have gcloud; then
    local token
    if token=$(gcloud auth print-access-token 2>/dev/null) && [ -n "$token" ]; then
      printf '%s' "$token"
      return 0
    fi
  fi

  return 1
}

# --- Impersonation -----------------------------------------------------------

impersonated_token=""
expire_time=""

# The REST path is preferred because it impersonates from the credential the
# runbook authenticated with. gcloud is the fallback for the case where the
# session credential cannot be exchanged in bash (or is absent entirely) --
# `gcloud auth print-access-token --impersonate-service-account` uses gcloud's
# OWN login as the source identity, which is not necessarily this session's.
if ! src_token=$(source_access_token); then
  if have gcloud; then
    echo "No usable session credential; falling back to gcloud's own login..."
    impersonated_token=$(gcloud auth print-access-token \
      --impersonate-service-account="$TARGET_SA" 2>/dev/null || true)
  fi

  if [ -z "$impersonated_token" ]; then
    echo "ERROR: could not resolve a source credential to impersonate with."
    echo "Authenticate with the <GoogleAuth> block above first."
    exit 1
  fi
else
  echo "Using the IAM Credentials REST API to mint the impersonated token..."

  # The bearer token goes through a config file on STDIN, never `-H`: argv is
  # readable by every other user on the machine. The request BODY carries no
  # secret, so it stays on the command line.
  response=$(printf 'header = "Authorization: Bearer %s"\n' "$src_token" |
    curl -sS --config - -X POST \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg scope "$CLOUD_PLATFORM_SCOPE" --arg lifetime "${LIFETIME}s" \
        '{scope: [$scope], lifetime: $lifetime}')" \
      "${IAM_CREDENTIALS_URI}/projects/-/serviceAccounts/${TARGET_SA}:generateAccessToken")

  if [ "$(echo "$response" | jq -r 'has("error")')" = "true" ]; then
    echo "Failed to impersonate: $TARGET_SA"
    echo "Error: $(echo "$response" | jq -r '.error.message')"
    echo ""
    echo "The caller needs roles/iam.serviceAccountTokenCreator on the target"
    echo "service account, and the IAM Service Account Credentials API must be"
    echo "enabled on the project."
    exit 1
  fi

  impersonated_token=$(echo "$response" | jq -r '.accessToken // empty')
  expire_time=$(echo "$response" | jq -r '.expireTime // empty')
fi

if [ -z "$impersonated_token" ]; then
  echo "Failed to impersonate: $TARGET_SA"
  exit 1
fi

# Publish the token as block outputs. GoogleAuth's { block: ... } source reads
# GOOGLE_APPLICATION_CREDENTIALS, then GOOGLE_CREDENTIALS, then either of the
# access-token names below.
{
  echo "GOOGLE_OAUTH_ACCESS_TOKEN=${impersonated_token}"
  echo "CLOUDSDK_AUTH_ACCESS_TOKEN=${impersonated_token}"
  if [ -n "$project" ]; then
    echo "CLOUDSDK_CORE_PROJECT=${project}"
  fi
} >>"${RUNBOOK_OUTPUT:?RUNBOOK_OUTPUT is unset - run this from a Runbooks Command block}"

echo "Successfully impersonated: $TARGET_SA"
if [ -n "$expire_time" ]; then
  echo "Token expires at: $expire_time"
fi
echo "Wrote GOOGLE_OAUTH_ACCESS_TOKEN and CLOUDSDK_AUTH_ACCESS_TOKEN to \$RUNBOOK_OUTPUT"
