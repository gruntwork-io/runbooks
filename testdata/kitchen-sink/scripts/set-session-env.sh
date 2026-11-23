#!/usr/bin/env bash
echo "KS_ENV_VAR=kitchen-sink-value" >> "$RUNBOOK_ENV"
echo "KS_COUNTER=42" >> "$RUNBOOK_ENV"
# Stays in this script: later blocks don't see it
export KS_EXPORT_ONLY="not-for-later-blocks"
echo "Wrote KS_ENV_VAR and KS_COUNTER to \$RUNBOOK_ENV"
