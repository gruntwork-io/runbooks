#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN not set"
  exit 1
fi

# GitHub App installation tokens (ghs_) have no associated user, so /user
# returns 403. Use /installation/repositories instead — same endpoint the
# GitHubHttpClient.validateInstallationToken code path uses.
if [[ "$GITHUB_TOKEN" == ghs_* ]]; then
  response=$(curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    https://api.github.com/installation/repositories)

  repo_count=$(echo "$response" | jq -r '.total_count // "null"')
  if [ "$repo_count" = "null" ]; then
    echo "ERROR: Invalid installation token - could not list installation repositories"
    echo "Response: $response"
    exit 1
  fi

  echo "SUCCESS: Authenticated as GitHub App installation ($repo_count repo(s) accessible)"
  echo "RUNBOOK_OUTPUT:installation_repo_count=$repo_count"
  exit 0
fi

response=$(curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user)

username=$(echo "$response" | jq -r '.login')
if [ "$username" = "null" ]; then
  echo "ERROR: Invalid token - could not get username"
  echo "Response: $response"
  exit 1
fi

echo "SUCCESS: Authenticated as $username"
echo "RUNBOOK_OUTPUT:github_user=$username"
