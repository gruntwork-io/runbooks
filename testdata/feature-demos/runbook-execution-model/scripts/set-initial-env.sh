#!/usr/bin/env bash
# Set initial environment variables for the demo

echo "Setting initial environment variables..."

{
  echo "DEMO_VAR=hello-from-block-1"
  echo "DEMO_COUNT=1"
  echo "DEMO_PROJECT=runbooks-session-env-demo"
} >> "$RUNBOOK_ENV"

# An export stays inside this script: later blocks don't see it
export DEMO_EXPORT_ONLY="not-for-later-blocks"

echo ""
echo "Wrote DEMO_VAR, DEMO_COUNT and DEMO_PROJECT to \$RUNBOOK_ENV."
echo "Exported DEMO_EXPORT_ONLY, which later blocks won't see."
