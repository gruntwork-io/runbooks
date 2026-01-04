#!/usr/bin/env bash
# =============================================================================
# Runbooks Logging Library
# https://runbooks.gruntwork.io/authoring/blocks/command#logging
#
# Provides standardized logging functions for Runbooks scripts:
#   log_info  - Informational messages
#   log_warn  - Warning messages
#   log_error - Error messages (written to stderr)
#   log_debug - Debug messages (only when DEBUG=true)
#
# Output format: [ISO-8601-TIMESTAMP] [LEVEL] Message
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
# log_info - Log an informational message
# Usage: log_info "message"
# -----------------------------------------------------------------------------
log_info() {
  printf '[%s] [INFO]  %s\n' "$(_log_timestamp)" "$*"
}

# -----------------------------------------------------------------------------
# log_warn - Log a warning message
# Usage: log_warn "message"
# -----------------------------------------------------------------------------
log_warn() {
  printf '[%s] [WARN]  %s\n' "$(_log_timestamp)" "$*"
}

# -----------------------------------------------------------------------------
# log_error - Log an error message
# Usage: log_error "message"
# Note: Writes to stdout for deterministic ordering. Use >&2 if stderr is needed.
# -----------------------------------------------------------------------------
log_error() {
  printf '[%s] [ERROR] %s\n' "$(_log_timestamp)" "$*"
}

# -----------------------------------------------------------------------------
# log_debug - Log a debug message (only when DEBUG=true)
# Usage: log_debug "message"
# -----------------------------------------------------------------------------
log_debug() {
  if [ "${DEBUG:-}" = "true" ]; then
    printf '[%s] [DEBUG] %s\n' "$(_log_timestamp)" "$*"
  fi
}

