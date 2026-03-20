#!/bin/bash
set -e

# Check if root.hcl exists in the infra-live repo.
# Outputs has_root_hcl=true/false for use in downstream templates.
#
# Environment variables:
#   - REPO_FILES: Path to the infra-live clone
#   - RUNBOOK_DRY_RUN: Set to "true" to simulate

DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "🔍 Dry-run mode: Simulating root.hcl detection..."
    echo ""
    echo "[DRY-RUN] test -f \$REPO_FILES/root.hcl"
    echo ""
    echo "has_root_hcl=true" >> "$RUNBOOK_OUTPUT"
    echo "✅ Dry-run completed successfully!"
    exit 0
fi

echo "🔍 Checking for root.hcl in infra-live repo..."
echo "   Path: ${REPO_FILES}/root.hcl"
echo ""

if [ -f "${REPO_FILES}/root.hcl" ]; then
    echo "✅ Found root.hcl"
    echo "has_root_hcl=true" >> "$RUNBOOK_OUTPUT"
    exit 0
else
    echo "⚠️  No root.hcl found in the infra-live repo."
    echo "   The generated terragrunt.hcl will be self-contained (no include block)."
    echo "has_root_hcl=false" >> "$RUNBOOK_OUTPUT"
    exit 2
fi
