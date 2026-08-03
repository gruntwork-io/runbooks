#!/usr/bin/env bash
#
# Verify Google Cloud authentication using only what <GoogleAuth> injected into
# the environment. This is the Google analogue of `aws sts get-caller-identity`.
#
# The gcloud CLI is OPTIONAL. GoogleAuth exports a credentials *file* rather
# than a bearer token, so this script mints its own short-lived access token
# from that file with plain curl/jq/openssl, then calls Google's tokeninfo
# endpoint. If gcloud happens to be installed we let it do the work instead.
#
set -euo pipefail

CLOUD_PLATFORM_SCOPE="https://www.googleapis.com/auth/cloud-platform"
TOKEN_URI="https://oauth2.googleapis.com/token"
TOKENINFO_URI="https://oauth2.googleapis.com/tokeninfo"
CRM_URI="https://cloudresourcemanager.googleapis.com/v3"

have() { command -v "$1" >/dev/null 2>&1; }

for tool in curl jq; do
  if ! have "$tool"; then
    echo "ERROR: $tool is required to verify Google Cloud credentials"
    exit 1
  fi
done

# base64url with no padding, as required by JWS.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Exchange an authorized_user ADC document for an access token.
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

# Exchange a service account key for an access token via a self-signed JWT.
# This is exactly what google-auth-library's JWT client does, in bash.
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

# Resolve an access token from the session environment. Prints the token on
# stdout; returns non-zero when nothing works.
mint_access_token() {
  # 1. An ambient access token (the one documented exception to the
  #    "never export a bare bearer token" rule -- it was already there).
  if [ -n "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]; then
    printf '%s' "$GOOGLE_OAUTH_ACCESS_TOKEN"
    return 0
  fi
  if [ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ]; then
    printf '%s' "$CLOUDSDK_AUTH_ACCESS_TOKEN"
    return 0
  fi

  # 2. The credentials file GoogleAuth exported. Once a file is exported we
  #    mint from THAT file and nothing else: falling back to gcloud's own login
  #    here would verify a different identity and report a false success.
  #    Branch on the JSON `type` field, never on the filename -- the same file
  #    name can hold either shape.
  local creds="${GOOGLE_APPLICATION_CREDENTIALS:-}"
  if [ -n "$creds" ]; then
    [ -r "$creds" ] || return 1
    local cred_type token
    cred_type=$(jq -r '.type // "unknown"' "$creds")
    case "$cred_type" in
      authorized_user) token=$(token_from_authorized_user "$creds") ;;
      service_account) token=$(token_from_service_account "$creds") ;;
      *)
        # external_account / impersonated_service_account have no reasonable
        # bash equivalent. `gcloud auth application-default print-access-token`
        # resolves ADC, so it honours GOOGLE_APPLICATION_CREDENTIALS -- unlike
        # `gcloud auth print-access-token`, which uses gcloud's own login.
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

  # 3. No credential file was exported: fall back to gcloud's own login.
  if have gcloud; then
    local token
    if token=$(gcloud auth print-access-token 2>/dev/null) && [ -n "$token" ]; then
      printf '%s' "$token"
      return 0
    fi
  fi

  return 1
}

project="${CLOUDSDK_CORE_PROJECT:-${GOOGLE_CLOUD_PROJECT:-${GOOGLE_PROJECT:-}}}"

echo "=== Session credential ==="
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  echo "GOOGLE_APPLICATION_CREDENTIALS: $GOOGLE_APPLICATION_CREDENTIALS"
  if [ -r "${GOOGLE_APPLICATION_CREDENTIALS}" ]; then
    echo "Credential type:                $(jq -r '.type // "unknown"' "$GOOGLE_APPLICATION_CREDENTIALS")"
  else
    echo "ERROR: GOOGLE_APPLICATION_CREDENTIALS points at a file that cannot be read"
    exit 1
  fi
elif [ -n "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ] || [ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ]; then
  echo "Using an ambient OAuth access token from the environment"
else
  echo "ERROR: no Google Cloud credentials in the session environment."
  echo "Authenticate with the <GoogleAuth> block above first."
  exit 1
fi
echo "Project:                        ${project:-<unset>}"
echo "Account:                        ${CLOUDSDK_CORE_ACCOUNT:-<unset>}"
echo "Region:                         ${CLOUDSDK_COMPUTE_REGION:-<unset>}"

echo ""
echo "=== Token exchange ==="
if ! access_token=$(mint_access_token); then
  echo "ERROR: could not exchange the session credential for an access token."
  echo "The credential may be expired, revoked, or of an unsupported type."
  exit 1
fi
echo "Minted an access token from the session credential."

echo ""
echo "=== Identity (oauth2 tokeninfo) ==="
# The token goes in the POST BODY, read from stdin, never in argv or the URL:
# anything on curl's command line is visible to every other user on the box via
# `ps auxww` (and lands in any intercepting proxy's access log) for the token's
# full ~1h lifetime. `--data-urlencode "access_token=..."` would NOT fix this —
# it still places the value on the command line.
info=$(printf 'access_token=%s' "$access_token" | curl -sS --data @- "${TOKENINFO_URI}")

if [ "$(echo "$info" | jq -r 'has("error") or has("error_description")')" = "true" ]; then
  echo "ERROR: Google rejected the access token"
  echo "$info" | jq -r '.error_description // .error'
  exit 1
fi

principal=$(echo "$info" | jq -r '.email // .sub // .azp // "unknown"')
scopes=$(echo "$info" | jq -r '.scope // ""')
echo "Principal: $principal"
echo "Scopes:    ${scopes:-<none reported>}"

echo ""
echo "=== Project access (Cloud Resource Manager) ==="
if [ -z "$project" ]; then
  echo "No project in the session environment; skipping the project check."
else
  # Header via a config file on STDIN, for the same reason the token above is
  # POSTed rather than put in a query string: `-H` puts it in argv.
  project_json=$(printf 'header = "Authorization: Bearer %s"\n' "$access_token" |
    curl -sS --config - "${CRM_URI}/projects/${project}")
  if [ "$(echo "$project_json" | jq -r 'has("error")')" = "true" ]; then
    # Not fatal: a credential can be perfectly valid without resourcemanager
    # read access on this project.
    echo "WARNING: could not read project ${project}:"
    echo "$project_json" | jq -r '.error.message'
  else
    echo "Project ID:   $(echo "$project_json" | jq -r '.projectId')"
    echo "Display name: $(echo "$project_json" | jq -r '.displayName // "<none>"')"
    echo "State:        $(echo "$project_json" | jq -r '.state // "<unknown>"')"
  fi
fi

echo ""
echo "SUCCESS: Authenticated to Google Cloud as $principal"
echo "RUNBOOK_OUTPUT:google_principal=$principal"
echo "RUNBOOK_OUTPUT:google_project=$project"
