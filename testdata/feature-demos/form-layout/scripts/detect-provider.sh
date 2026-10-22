#!/usr/bin/env bash
set -euo pipefail

# Stands in for a <GitAuth> block's GIT_PROVIDER output. The hidden
# GitProvider field of the template below this block uses it.
PROVIDER="github"
echo "Detected Git provider $PROVIDER"

echo "provider=$PROVIDER" >> "$RUNBOOK_OUTPUT"
