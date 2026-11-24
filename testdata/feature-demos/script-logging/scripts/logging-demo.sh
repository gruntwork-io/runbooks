#!/usr/bin/env bash
# =============================================================================
# Logging Demo Script
# Appends a line to each of the four log files Runbooks creates for a run
# =============================================================================
set -euo pipefail

echo "========================================="
echo "  Runbooks Logging Demo"
echo "========================================="
echo ""

echo "This is an informational message" >> "$RUNBOOK_INFO_LOG"
echo "Use \$RUNBOOK_INFO_LOG for general progress updates" >> "$RUNBOOK_INFO_LOG"

echo "This is a warning message" >> "$RUNBOOK_WARN_LOG"
echo "Use \$RUNBOOK_WARN_LOG for non-fatal issues" >> "$RUNBOOK_WARN_LOG"

echo "This is a debug message" >> "$RUNBOOK_DEBUG_LOG"
echo "Use \$RUNBOOK_DEBUG_LOG for verbose troubleshooting output" >> "$RUNBOOK_DEBUG_LOG"

echo "This is an error message" >> "$RUNBOOK_ERROR_LOG"
echo "Use \$RUNBOOK_ERROR_LOG for failures before exiting" >> "$RUNBOOK_ERROR_LOG"

# The log files aren't stdout, so logging inside a function whose output is
# captured leaves the captured value alone.
get_greeting() {
  echo "Building a greeting..." >> "$RUNBOOK_INFO_LOG"
  echo "hello"
}
GREETING=$(get_greeting)
echo "Captured greeting: $GREETING"

echo ""
echo "========================================="
echo "  Demo Complete!"
echo "========================================="
