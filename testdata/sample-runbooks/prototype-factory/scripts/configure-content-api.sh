#!/usr/bin/env bash
set -e

# --- Runbooks Logging ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---

PROJECT_NAME="{{ .ProjectName }}"

log_info "Provisioning Content Service API for: ${PROJECT_NAME}"

# --- Mock: Scaffold FastAPI content service ---
log_info "Scaffolding FastAPI content service..."
sleep 0.5
log_info "  Created: api/content_service/"
log_info "  Created: api/content_service/main.py"
log_info "  Created: api/content_service/routes/works.py"
log_info "  Created: api/content_service/routes/passages.py"
log_info "  Created: api/content_service/routes/context.py"
log_info "  Created: api/content_service/models/citation.py"
log_info "Content service scaffold complete."

# --- Mock: Configure canonical content addressing ---
log_info "Configuring canonical content addressing..."
sleep 0.5
log_info "  Citation schema: work_id + locator + snippet + context_window"
log_info "  Locator format: {work_id}/{chapter}/{section}/{paragraph}"
log_info "  Deep links: enabled (read-in-context support)"
log_info "  Chunk IDs: internal only (locators are the public contract)"
log_info "Canonical addressing configured."

# --- Mock: Set up content index ---
log_info "Building initial content index..."
sleep 1
log_info "  Indexed: 0 works (empty catalog, ready for ingestion)"
log_info "  Formats supported: HTML-first, EPUB-compatible bridge"
log_info "  Context views: section, chapter, book"
log_info "Content index ready."

echo ""
log_info "=== Content Service API ==="
log_info "  Framework:     FastAPI"
log_info "  Endpoints:"
log_info "    GET  /api/v1/works"
log_info "    GET  /api/v1/works/{work_id}/passages"
log_info "    GET  /api/v1/works/{work_id}/context"
log_info "  Citations:     Canonical locator schema"
log_info "  Deep links:    Enabled"

echo "content_api_configured=true" >> "$RUNBOOK_OUTPUT"
