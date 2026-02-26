#!/usr/bin/env bash
set -euo pipefail

# --- Runbooks Logging ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---

PROJECT_NAME="{{ .ProjectName }}"

if [ -z "$REPO_FILES" ]; then
    log_error "No cloned repo found. Please run the GitClone step first."
    exit 1
fi

log_info "Scaffolding Next.js frontend into: ${REPO_FILES}"
cd "$REPO_FILES"

# Scaffold into a temp directory and copy files over so create-next-app doesn't
# reinitialize git or clear the existing working tree.
SCAFFOLD_TMP="$(mktemp -d)"
trap 'rm -rf "$SCAFFOLD_TMP"' EXIT

log_info "Running create-next-app..."
npx create-next-app@latest "$SCAFFOLD_TMP/$PROJECT_NAME" \
  --yes \
  --ts \
  --tailwind \
  --eslint \
  --app \
  --src-dir \
  --import-alias "@/*" \
  --use-npm 2>&1

rm -rf "$SCAFFOLD_TMP/$PROJECT_NAME/.git" "$SCAFFOLD_TMP/$PROJECT_NAME/node_modules"
cp -a "$SCAFFOLD_TMP/$PROJECT_NAME/." .
rm -rf "$SCAFFOLD_TMP"

# Install all dependencies (from the scaffold's package.json) plus Supabase.
log_info "Installing dependencies..."
npm install @supabase/supabase-js @supabase/auth-helpers-nextjs 2>&1

# Add a standard env template expected by later steps.
if [ ! -f ".env.example" ]; then
  cat > .env.example << 'EOF'
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EOF
  log_info "Created .env.example"
fi

echo ""
log_info "=== Frontend Scaffold ==="
log_info "  Framework:     Next.js (create-next-app defaults)"
log_info "  Styling:       Tailwind CSS"
log_info "  Language:      TypeScript"
log_info "  Auth:          Supabase Auth Helpers (installed)"
