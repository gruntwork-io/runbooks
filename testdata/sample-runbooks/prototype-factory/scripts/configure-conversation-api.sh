#!/usr/bin/env bash
set -e

# --- Runbooks Logging ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---

PROJECT_NAME="{{ .ProjectName }}"

log_info "Provisioning Conversation Service API for: ${PROJECT_NAME}"

# --- Mock: Scaffold FastAPI project ---
log_info "Scaffolding FastAPI application..."
sleep 0.5
log_info "  Created: api/conversation_service/"
log_info "  Created: api/conversation_service/main.py"
log_info "  Created: api/conversation_service/routes/"
log_info "  Created: api/conversation_service/models/"
log_info "  Created: api/conversation_service/middleware/"
log_info "FastAPI scaffold complete."

# --- Mock: Configure orchestrator pipeline ---
log_info "Configuring orchestrator pipeline..."
sleep 0.5
log_info "  Pipeline: auth_context -> retrieval -> prompt_selection -> model_call -> persistence -> telemetry"
log_info "  Streaming: SSE enabled"
log_info "  Request validation: enabled"
log_info "  Idempotent writes: enabled"
log_info "Orchestrator pipeline configured."

# --- Mock: Set up LLM provider ---
log_info "Configuring LLM provider..."
sleep 0.5
MOCK_LLM_API_KEY="sk-mock-$(date +%s | shasum -a 256 | head -c 32)"
log_info "  Provider: Anthropic (Claude)"
log_info "  Model: claude-sonnet-4-20250514"
log_info "  Max tokens: 4096"
log_info "  Temperature: 0.3 (grounded retrieval)"
log_info "LLM provider configured."

# --- Mock: Configure prompt registry ---
log_info "Setting up prompt registry..."
sleep 0.5
log_info "  Registered: system_prompt_v1 (pinned)"
log_info "  Registered: retrieval_grounding_v1 (pinned)"
log_info "  Registered: citation_formatting_v1 (pinned)"
log_info "  Version tracking: enabled"
log_info "  Experiment pinning: enabled"
log_info "Prompt registry initialized."

echo ""
log_info "=== Conversation Service API ==="
log_info "  Framework:     FastAPI"
log_info "  Endpoint:      POST /api/v1/chat"
log_info "  Streaming:     SSE via /api/v1/chat/stream"
log_info "  LLM Provider:  Anthropic (Claude)"
log_info "  API Key:       ${MOCK_LLM_API_KEY:0:20}..."

echo "conversation_api_key=${MOCK_LLM_API_KEY}" >> "$RUNBOOK_OUTPUT"
