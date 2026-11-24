#!/usr/bin/env bash
set -euo pipefail
echo "This is an informational message" >> "$RUNBOOK_INFO_LOG"
echo "This is a warning message" >> "$RUNBOOK_WARN_LOG"
echo "This is an error message (non-fatal in this demo)" >> "$RUNBOOK_ERROR_LOG"
echo "This is a debug message" >> "$RUNBOOK_DEBUG_LOG"
echo ""
echo "Logging demo complete. All four levels exercised."
