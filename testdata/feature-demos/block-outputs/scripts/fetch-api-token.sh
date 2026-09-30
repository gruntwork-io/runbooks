#!/bin/bash
echo "Fetching an API token..."

# Simulate fetching a credential. Never echo it: the log isn't masked.
API_USER="demo-user"
API_TOKEN="demo-$(date +%s)-token"

echo "Token fetched for $API_USER."

# api_user is shown in View Outputs as usual. The sensitive: prefix masks
# api_token there; downstream blocks still read it as .outputs.fetch_api_token.api_token
echo "api_user=$API_USER" >> "$RUNBOOK_OUTPUT"
echo "sensitive:api_token=$API_TOKEN" >> "$RUNBOOK_OUTPUT"
