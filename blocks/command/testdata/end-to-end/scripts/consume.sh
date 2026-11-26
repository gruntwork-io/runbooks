#!/usr/bin/env bash
set -euo pipefail
test "$FROM_SETUP" = eu-west-2
test "$REGION" = us-east-1
echo "seen=$FROM_SETUP/$REGION" >> "$RUNBOOK_OUTPUT"
