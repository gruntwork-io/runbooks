#!/usr/bin/env bash
set -e

# --- Runbooks Logging ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---

PROJECT_NAME="{{ .ProjectName }}"

log_info "Provisioning vector database for: ${PROJECT_NAME}"

# --- Mock: Create Pinecone index ---
log_info "Creating Pinecone index '${PROJECT_NAME}-embeddings'..."
sleep 1
MOCK_PINECONE_API_KEY="pcsk-mock-$(date +%s | shasum -a 256 | head -c 24)"
MOCK_PINECONE_HOST="${PROJECT_NAME}-embeddings-abc123.svc.us-east-1.pinecone.io"
log_info "  Index name:    ${PROJECT_NAME}-embeddings"
log_info "  Dimension:     1536 (OpenAI ada-002 compatible)"
log_info "  Metric:        cosine"
log_info "  Cloud:         AWS"
log_info "  Region:        us-east-1"
log_info "Pinecone index created."

# --- Mock: Configure retrieval interface ---
log_info "Configuring retrieval interface..."
sleep 0.5
log_info "  Interface: RetrievalProvider (abstract)"
log_info "  Implementation: PineconeRetriever"
log_info "  Contract: query(text, filters, top_k) -> List[Chunk(id, score, metadata, snippet)]"
log_info "  Designed for swap to: Databricks Vector Search"
log_info "Retrieval interface configured."

# --- Mock: Set up metadata filtering ---
log_info "Configuring metadata filters..."
sleep 0.5
log_info "  Filterable fields: teacher, collection, topic, work_id"
log_info "  Namespace support: enabled (per-tenant isolation)"
log_info "Metadata filters ready."

echo ""
log_info "=== Vector Database ==="
log_info "  Provider:      Pinecone"
log_info "  Index:         ${PROJECT_NAME}-embeddings"
log_info "  Host:          ${MOCK_PINECONE_HOST}"
log_info "  API Key:       ${MOCK_PINECONE_API_KEY:0:20}..."
log_info "  Dimension:     1536"
log_info "  Swap target:   Databricks Vector Search"

echo "pinecone_api_key=${MOCK_PINECONE_API_KEY}" >> "$RUNBOOK_OUTPUT"
echo "pinecone_host=${MOCK_PINECONE_HOST}" >> "$RUNBOOK_OUTPUT"
