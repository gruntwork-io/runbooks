#!/bin/bash
# =============================================================================
# Logging Demo Script
# Demonstrates all four logging functions provided by Runbooks
# =============================================================================

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

# Any command can append to the log files directly. Runbooks shows each line
# at the file's level.
echo "This line was appended to \$RUNBOOK_WARN_LOG directly" >> "$RUNBOOK_WARN_LOG"

# The logging functions never write to stdout, so they are safe inside a
# function whose output you capture.
get_greeting() {
  log_info "Building a greeting..."
  echo "hello"
}
GREETING=$(get_greeting)
echo "Captured greeting: $GREETING"

echo ""
echo "========================================="
echo "  Demo Complete!"
echo "========================================="

exit 0

