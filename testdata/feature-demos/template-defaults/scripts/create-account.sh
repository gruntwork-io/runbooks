#!/usr/bin/env bash
set -euo pipefail

# Simulates creating an account. The ID it outputs is what the linked
# AccountAlias default above this block waits on.
ACCOUNT_ID="123456789012"
echo "Created account $ACCOUNT_ID"

echo "account_id=$ACCOUNT_ID" >> "$RUNBOOK_OUTPUT"
