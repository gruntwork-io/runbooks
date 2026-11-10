#!/usr/bin/env bash
#
# Checks that the signed-in project has the Google APIs this runbook calls turned on,
# so a missing one shows up here, with a link to turn it on, rather than as a failed
# lookup or plan later. Fails for the APIs the apply needs, and warns for the ones
# only the form's suggestions need.
#
set -euo pipefail

TOKEN_URI="https://oauth2.googleapis.com/token"
SERVICE_USAGE_URI="https://serviceusage.googleapis.com/v1"

# Service, what it's for, and whether the apply needs it.
APIS=(
  "cloudidentity.googleapis.com|Cloud Identity API|creates the group|required"
  "cloudresourcemanager.googleapis.com|Cloud Resource Manager API|finds your organization from its domain|required"
  "admin.googleapis.com|Admin SDK API|suggests your organization's domains|suggestions"
  "people.googleapis.com|People API|suggests owners and members|suggestions"
)

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: this check needs $tool."
    exit 1
  fi
done

project="${GOOGLE_CLOUD_PROJECT:-${GOOGLE_PROJECT:-}}"
if [ -z "$project" ]; then
  echo "ERROR: no Google Cloud project in the session. Sign in above, and pick the project."
  exit 1
fi

# An access token for the session's credential. The secrets go to curl on stdin, never in argv.
access_token() {
  if [ -n "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]; then
    printf '%s' "$GOOGLE_OAUTH_ACCESS_TOKEN"
    return 0
  fi
  local creds="${GOOGLE_APPLICATION_CREDENTIALS:-}"
  [ -n "$creds" ] && [ -r "$creds" ] || return 1
  case "$(jq -r '.type // ""' "$creds")" in
    authorized_user)
      jq -r '"grant_type=refresh_token"
             + "&client_id=" + (.client_id | @uri)
             + "&client_secret=" + (.client_secret | @uri)
             + "&refresh_token=" + (.refresh_token | @uri)' "$creds" |
        curl -sS -X POST --data @- "$TOKEN_URI" |
        jq -r '.access_token // empty'
      ;;
    *)
      command -v gcloud >/dev/null 2>&1 || return 1
      gcloud auth application-default print-access-token 2>/dev/null
      ;;
  esac
}

token=$(access_token || true)
if [ -z "$token" ]; then
  echo "ERROR: couldn't get an access token from the session's Google credential. Sign in again above."
  exit 1
fi

echo "Project: $project"
echo ""

missing_required=0
missing_suggestions=0
for api in "${APIS[@]}"; do
  IFS='|' read -r service name purpose need <<<"$api"
  answer=$(printf 'header = "Authorization: Bearer %s"\nheader = "x-goog-user-project: %s"\n' "$token" "$project" |
    curl -sS --config - "$SERVICE_USAGE_URI/projects/$project/services/$service")
  error=$(jq -r '.error.message // empty' <<<"$answer")
  if [ -n "$error" ]; then
    echo "ERROR: couldn't read whether the $name is on: $error"
    exit 1
  fi
  if [ "$(jq -r '.state // ""' <<<"$answer")" = "ENABLED" ]; then
    echo "✓ $name ($purpose)"
    continue
  fi
  echo "✗ $name ($purpose) is off. Turn it on:"
  echo "  https://console.cloud.google.com/apis/library/$service?project=$project"
  if [ "$need" = "required" ]; then
    missing_required=$((missing_required + 1))
  else
    missing_suggestions=$((missing_suggestions + 1))
  fi
done

if [ "$missing_required" -gt 0 ]; then
  echo ""
  echo "Turn on the APIs marked ✗, wait a minute or two, and check again."
  exit 1
fi
if [ "$missing_suggestions" -gt 0 ]; then
  echo ""
  echo "The group can still be created: type the values the suggestions would have offered."
  exit 2
fi
