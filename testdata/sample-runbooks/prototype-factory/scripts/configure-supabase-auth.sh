#!/usr/bin/env bash
set -e

# --- Runbooks Logging ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---

PROJECT_NAME="{{ .ProjectName }}"

log_info "Configuring Supabase Auth for project: ${PROJECT_NAME}"

# --- Mock: Simulate Supabase project creation ---
log_info "Creating Supabase project '${PROJECT_NAME}-db'..."
sleep 1
MOCK_SUPABASE_URL="https://${PROJECT_NAME}-db.supabase.co"
MOCK_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock-anon-key-$(date +%s)"
MOCK_SUPABASE_SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock-service-key-$(date +%s)"
log_info "Supabase project created."

# --- Mock: Configure Microsoft OAuth provider ---
log_info "Configuring Microsoft OAuth provider..."
sleep 0.5
log_info "  Provider: Microsoft Azure AD"
log_info "  Tenant: organizations (multi-tenant)"
log_info "  Scopes: openid, email, profile"
log_info "Microsoft OAuth provider configured."

# --- Mock: Set up org-based access rules ---
log_info "Setting up org-based access rules..."
sleep 0.5
log_info "  Rule: Allow @PrototypeTeam domain only"
log_info "  Role claim: default -> 'viewer'"
log_info "  Admin override: enabled for prototype team"
log_info "Access rules configured."

# --- Mock: Create initial database schema ---
log_info "Running initial auth schema migration..."
sleep 0.5
log_info "  Created table: auth.users"
log_info "  Created table: auth.sessions"
log_info "  Created table: public.profiles (tenant_id, role, org)"
log_info "Schema migration complete."

echo ""
log_info "=== Supabase Auth Configuration ==="
log_info "  URL:          ${MOCK_SUPABASE_URL}"
log_info "  Anon Key:     ${MOCK_SUPABASE_ANON_KEY:0:40}..."
log_info "  Service Key:  ${MOCK_SUPABASE_SERVICE_KEY:0:40}..."
log_info "  Auth Method:  Microsoft OAuth + org-domain gating"

# Write outputs for downstream blocks
echo "supabase_url=${MOCK_SUPABASE_URL}" >> "$RUNBOOK_OUTPUT"
echo "supabase_anon_key=${MOCK_SUPABASE_ANON_KEY}" >> "$RUNBOOK_OUTPUT"
