#!/bin/bash
# =============================================================================
# Logging Demo Script
# Demonstrates all four logging functions provided by Runbooks
# =============================================================================

# --- Runbooks Logging (https://runbooks.gruntwork.io/authoring/blocks/command#logging) ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---

echo "========================================="
echo "  Runbooks Logging Demo"
echo "========================================="
echo ""

# Demonstrate log_info
log_info "This is an informational message"
log_info "Use log_info for general progress updates"

echo ""

# Demonstrate log_warn
log_warn "This is a warning message"
log_warn "Use log_warn for non-fatal issues"

echo ""

# Demonstrate log_debug (only shows if DEBUG=true)
log_debug "This is a debug message"
log_debug "Use log_debug for verbose troubleshooting output"

if [ "${DEBUG:-}" != "true" ]; then
  log_info "Debug messages are hidden. Set DEBUG=true to see them."
fi

echo ""

# Demonstrate log_error
log_error "This is an error message"
log_error "Use log_error for failures before exiting"

echo ""
echo "========================================="
echo "  Demo Complete!"
echo "========================================="

exit 0

