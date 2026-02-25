#!/usr/bin/env bash
set -e

# --- Runbooks Logging ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---

PROJECT_NAME="{{ .ProjectName }}"

log_info "Configuring cache and rate limiting for: ${PROJECT_NAME}"

# --- Mock: Provision Upstash Redis ---
log_info "Provisioning Upstash Redis instance..."
sleep 0.5
MOCK_REDIS_URL="rediss://default:mock-token@usw1-${PROJECT_NAME}.upstash.io:6379"
log_info "  Instance: ${PROJECT_NAME}-cache"
log_info "  Region: us-west-1"
log_info "  Type: Pay-as-you-go (prototype tier)"
log_info "Upstash Redis provisioned."

# --- Mock: Configure rate limiting rules ---
log_info "Configuring rate limiting rules..."
sleep 0.5
log_info "  Per-user limit:  60 requests / minute"
log_info "  Per-org limit:   600 requests / minute"
log_info "  Burst allowance: 10 requests"
log_info "  Window type:     Sliding window"
log_info "Rate limiting configured."

# --- Mock: Configure retrieval cache ---
log_info "Setting up retrieval result cache..."
sleep 0.5
log_info "  Cache TTL:       300s (5 minutes)"
log_info "  Cache key:       hash(query + filters + top_k)"
log_info "  Max entries:     10,000"
log_info "  Eviction:        LRU"
log_info "Retrieval cache configured."

echo ""
log_info "=== Cache & Rate Limiting ==="
log_info "  Provider:      Upstash Redis"
log_info "  Redis URL:     ${MOCK_REDIS_URL:0:40}..."
log_info "  Rate limits:   60/min per user, 600/min per org"
log_info "  Cache TTL:     5 minutes"
log_info "  Swap target:   Cloudflare WAF + ElastiCache"

echo "redis_url=${MOCK_REDIS_URL}" >> "$RUNBOOK_OUTPUT"
