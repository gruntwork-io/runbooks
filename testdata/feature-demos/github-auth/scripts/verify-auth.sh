#!/usr/bin/env bash
set -euo pipefail

# Verify GITHUB_TOKEN is set
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN not set"
  exit 1
fi

# Call GitHub API to verify token
response=$(curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user)

username=$(echo "$response" | jq -r '.login')
if [ "$username" = "null" ]; then
  echo "ERROR: Invalid token - could not get username"
  echo "Response: $response"
  exit 1
fi

echo "SUCCESS: Authenticated as $username"
echo "RUNBOOK_OUTPUT:github_user=$username"
