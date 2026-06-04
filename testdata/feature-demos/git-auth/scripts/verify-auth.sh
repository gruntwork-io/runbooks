#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GITLAB_TOKEN:-}" ]; then
  echo "ERROR: GITLAB_TOKEN not set"
  exit 1
fi

# GitLab tokens (personal/project/group access tokens and OAuth tokens)
# authenticate via the PRIVATE-TOKEN header.
response=$(curl -sS -H "PRIVATE-TOKEN: $GITLAB_TOKEN" https://gitlab.com/api/v4/user)

username=$(echo "$response" | jq -r '.username')
if [ "$username" = "null" ] || [ -z "$username" ]; then
  echo "ERROR: Invalid token - could not get username"
  echo "Response: $response"
  exit 1
fi

echo "SUCCESS: Authenticated as $username"
echo "RUNBOOK_OUTPUT:gitlab_user=$username"
