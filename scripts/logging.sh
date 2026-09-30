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
# Each function appends to the log file Runbooks names in an environment
# variable: RUNBOOK_INFO_LOG, RUNBOOK_WARN_LOG, RUNBOOK_ERROR_LOG or
# RUNBOOK_DEBUG_LOG. Outside Runbooks the variable is unset and the function
# writes to stderr instead. Either way nothing goes to stdout, so it is safe
# to log inside a function whose output is captured with $(...).
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
# Helper: Append a log line to FILE, or to stderr if FILE is empty
# Usage: _log_write FILE TAG MESSAGE...
# -----------------------------------------------------------------------------
_log_write() {
  local file="$1" tag="$2"
  shift 2
  if [ -n "$file" ]; then
    printf '[%s] %s %s\n' "$(_log_timestamp)" "$tag" "$*" >> "$file"
  else
    printf '[%s] %s %s\n' "$(_log_timestamp)" "$tag" "$*" >&2
  fi
}

# -----------------------------------------------------------------------------
# log_info - Log an informational message to $RUNBOOK_INFO_LOG
# Usage: log_info "message"
# -----------------------------------------------------------------------------
log_info() {
  _log_write "${RUNBOOK_INFO_LOG:-}" "[INFO] " "$@"
}

# -----------------------------------------------------------------------------
# log_warn - Log a warning message to $RUNBOOK_WARN_LOG
# Usage: log_warn "message"
# -----------------------------------------------------------------------------
log_warn() {
  _log_write "${RUNBOOK_WARN_LOG:-}" "[WARN] " "$@"
}

# -----------------------------------------------------------------------------
# log_error - Log an error message to $RUNBOOK_ERROR_LOG
# Usage: log_error "message"
# -----------------------------------------------------------------------------
log_error() {
  _log_write "${RUNBOOK_ERROR_LOG:-}" "[ERROR]" "$@"
}

# -----------------------------------------------------------------------------
# log_debug - Log a debug message to $RUNBOOK_DEBUG_LOG (only when DEBUG=true)
# Usage: log_debug "message"
# -----------------------------------------------------------------------------
log_debug() {
  if [ "${DEBUG:-}" = "true" ]; then
    _log_write "${RUNBOOK_DEBUG_LOG:-}" "[DEBUG]" "$@"
  fi
}
