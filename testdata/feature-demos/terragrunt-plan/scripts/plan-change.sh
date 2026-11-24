#!/bin/bash
# Plans the change under review in every unit of the stack. Runbooks shows
# what the plans will change in the block's View Plan panel, from the JSON
# plans written to $RUNBOOK_PLAN_DIR, and each unit's result from the report.
set -euo pipefail

cd "$STACK_DIR"
PLAN_DEMO_CHANGE=true terragrunt run --all --non-interactive \
  --json-out-dir "$RUNBOOK_PLAN_DIR" \
  --report-file "$RUNBOOK_PLAN_DIR/report.json" \
  -- plan
