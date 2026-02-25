#!/usr/bin/env bash
set -e

# --- Runbooks Logging ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---

PROJECT_NAME="{{ .ProjectName }}"

log_info "Configuring telemetry and traces for: ${PROJECT_NAME}"

# --- Mock: Set up LangSmith project ---
log_info "Creating LangSmith project '${PROJECT_NAME}'..."
sleep 0.5
MOCK_LANGSMITH_API_KEY="lsv2-mock-$(date +%s | shasum -a 256 | head -c 24)"
log_info "  Project: ${PROJECT_NAME}"
log_info "  Organization: prototype-team"
log_info "LangSmith project created."

# --- Mock: Configure trace schema ---
log_info "Configuring trace schema..."
sleep 0.5
log_info "  Trace fields:"
log_info "    - model (string)"
log_info "    - tokens_in / tokens_out (int)"
log_info "    - latency_ms (int)"
log_info "    - retriever (string)"
log_info "    - prompt_version (string)"
log_info "    - citations (list[locator])"
log_info "    - experiment_id (string)"
log_info "  Trace schema configured."

# --- Mock: Configure feedback capture ---
log_info "Setting up feedback capture..."
sleep 0.5
log_info "  Feedback tags: off-tone, uncited, hallucination, too-long, helpful"
log_info "  Capture mode: per-message, optional user annotation"
log_info "  Storage: conversation_service DB + LangSmith trace link"
log_info "Feedback capture configured."

# --- Mock: Set up golden set evaluation ---
log_info "Initializing evaluation framework..."
sleep 0.5
log_info "  Golden set: empty (ready for curation)"
log_info "  Eval metrics: citation_accuracy, groundedness, faithfulness"
log_info "  Regression check: enabled (blocks deploy on regression)"
log_info "Evaluation framework initialized."

# --- Mock: Configure logging redaction ---
log_info "Setting up log redaction rules..."
sleep 0.5
log_info "  Redacted: user message content in system logs"
log_info "  Preserved: metadata, token counts, latency"
log_info "  Full content: only in encrypted trace store"
log_info "Log redaction configured."

echo ""
log_info "=== Telemetry & Traces ==="
log_info "  Provider:      LangSmith"
log_info "  API Key:       ${MOCK_LANGSMITH_API_KEY:0:20}..."
log_info "  Trace schema:  model, tokens, latency, retriever, prompt_version, citations"
log_info "  Feedback:      off-tone, uncited, hallucination, too-long, helpful"
log_info "  Eval:          Golden set framework ready"
log_info "  Swap target:   Databricks structured trace events"

echo "langsmith_api_key=${MOCK_LANGSMITH_API_KEY}" >> "$RUNBOOK_OUTPUT"
