#!/usr/bin/env bash
# Change the session's variables by writing new values to RUNBOOK_ENV

echo "Current values:"
echo "  DEMO_VAR=$DEMO_VAR"
echo "  DEMO_COUNT=$DEMO_COUNT"
echo ""

{
  echo "DEMO_COUNT=$((DEMO_COUNT + 1))"
  echo "DEMO_MODIFIED=modified-in-block-3"
  echo "DEMO_VAR=updated-in-block-3"
} >> "$RUNBOOK_ENV"

echo "New values for later blocks:"
echo "  DEMO_VAR=updated-in-block-3 (updated)"
echo "  DEMO_COUNT=$((DEMO_COUNT + 1)) (incremented)"
echo "  DEMO_MODIFIED=modified-in-block-3 (new)"
