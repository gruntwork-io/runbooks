#!/bin/bash
# =============================================================================
# Debug Check Script
# Demonstrates how DEBUG=true enables verbose log_debug output
# =============================================================================

# --- Runbooks Logging (https://runbooks.gruntwork.io/authoring/blocks/command#logging) ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---

# Set DEBUG based on input variable (passed from Runbooks Inputs block)
if [ "{{ .EnableDebug }}" = "true" ]; then
  export DEBUG=true
fi

log_info "Starting system check..."

# Debug output - only visible when DEBUG=true
log_debug "Current working directory: $(pwd)"
log_debug "User: $(whoami)"
log_debug "Shell: $SHELL"
log_debug "PATH contains $(echo "$PATH" | tr ':' '\n' | wc -l | tr -d ' ') directories"

# Perform a simple check
if command -v bash &>/dev/null; then
  BASH_VERSION_STR=$(bash --version | head -1)
  log_info "Bash is available"
  log_debug "Bash version details: $BASH_VERSION_STR"
else
  log_error "Bash not found"
  exit 1
fi

# Check for common tools
for tool in git curl; do
  if command -v "$tool" &>/dev/null; then
    log_debug "Found $tool: $(command -v "$tool")"
  else
    log_warn "$tool not found (optional)"
  fi
done

log_info "System check complete"

if [ "${DEBUG:-}" = "true" ]; then
  log_debug "Total checks performed: 3"
fi

exit 0

