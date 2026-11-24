#!/usr/bin/env bash
# =============================================================================
# Debug Check Script
# Writes debug lines only when DEBUG=true. The block's env prop sets DEBUG
# from the EnableDebug input, for this run only.
# =============================================================================
set -euo pipefail

debug() {
  if [ "${DEBUG:-}" = "true" ]; then
    echo "$*" >> "$RUNBOOK_DEBUG_LOG"
  fi
}

echo "Starting system check..." >> "$RUNBOOK_INFO_LOG"

debug "Current working directory: $(pwd)"
debug "User: $(whoami)"
debug "Shell: ${SHELL:-unknown}"
debug "PATH contains $(echo "$PATH" | tr ':' '\n' | wc -l | tr -d ' ') directories"

if command -v bash &>/dev/null; then
  echo "Bash is available" >> "$RUNBOOK_INFO_LOG"
  debug "Bash version details: $(bash --version | head -1)"
else
  echo "Bash not found" >> "$RUNBOOK_ERROR_LOG"
  exit 1
fi

for tool in git curl; do
  if command -v "$tool" &>/dev/null; then
    debug "Found $tool: $(command -v "$tool")"
  else
    echo "$tool not found (optional)" >> "$RUNBOOK_WARN_LOG"
  fi
done

echo "System check complete" >> "$RUNBOOK_INFO_LOG"
