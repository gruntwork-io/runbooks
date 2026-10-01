#!/usr/bin/env bash
# =============================================================================
# Runbooks Logging Library
# https://runbooks.gruntwork.io/authoring/blocks/command#logging
#
# Provides standardized logging functions for Runbooks scripts:
#   log_info  - Informational messages
#   log_warn  - Warning messages
#   log_error - Error messages
#   log_debug - Debug messages (only when DEBUG=true)
#
# Output format: [ISO-8601-TIMESTAMP] [LEVEL] Message
#
# Every function appends to the log file Runbooks names in RUNBOOK_LOG, so
# the lines keep the order they were written in. Outside Runbooks the variable
# is unset, and the functions write to stderr instead. They also fall back to
# stderr when the file can't be written, e.g. from a background job that is
# still logging after the run ended and Runbooks deleted the file. Either way
# nothing goes to stdout, so it is safe to log inside a function whose output
# is captured with $(...).
#
# Compatible with Bash 3.2+ (macOS default version) and POSIX shells where possible.
# =============================================================================

# Guard against multiple sourcing
if [ -n "${_RUNBOOKS_LOGGING_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
_RUNBOOKS_LOGGING_LOADED=1

# -----------------------------------------------------------------------------
# Helper: Get UTC timestamp in ISO-8601 format
# -----------------------------------------------------------------------------
_log_timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# -----------------------------------------------------------------------------
# Helper: Append a log line to $RUNBOOK_LOG, or write it to stderr if
# RUNBOOK_LOG is unset or the append fails
# Usage: _log_write TAG MESSAGE...
# -----------------------------------------------------------------------------
_log_write() {
  local tag="$1"
  shift
  if [ -n "${RUNBOOK_LOG:-}" ] &&
    { printf '[%s] %s %s\n' "$(_log_timestamp)" "$tag" "$*" >> "$RUNBOOK_LOG"; } 2>/dev/null; then
    return 0
  fi
  printf '[%s] %s %s\n' "$(_log_timestamp)" "$tag" "$*" >&2
}

# -----------------------------------------------------------------------------
# log_info - Log an informational message
# Usage: log_info "message"
# -----------------------------------------------------------------------------
log_info() {
  _log_write "[INFO] " "$@"
}

# -----------------------------------------------------------------------------
# log_warn - Log a warning message
# Usage: log_warn "message"
# -----------------------------------------------------------------------------
log_warn() {
  _log_write "[WARN] " "$@"
}

# -----------------------------------------------------------------------------
# log_error - Log an error message
# Usage: log_error "message"
# -----------------------------------------------------------------------------
log_error() {
  _log_write "[ERROR]" "$@"
}

# -----------------------------------------------------------------------------
# log_debug - Log a debug message (only when DEBUG=true)
# Usage: log_debug "message"
# -----------------------------------------------------------------------------
log_debug() {
  if [ "${DEBUG:-}" = "true" ]; then
    _log_write "[DEBUG]" "$@"
  fi
}
