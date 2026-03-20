#!/bin/bash
set -e

# Look up the latest versions of OpenTofu and Terragrunt from GitHub releases.

DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "🔍 Dry-run mode: Simulating version lookup..."
    echo ""
    echo "[DRY-RUN] gh release view --repo opentofu/opentofu --json tagName"
    echo "[DRY-RUN] gh release view --repo gruntwork-io/terragrunt --json tagName"
    echo ""
    echo "✅ Dry-run completed successfully!"
    exit 0
fi

echo "🔍 Looking up latest tool versions..."
echo ""

OPENTOFU_VERSION=$(gh release view --repo opentofu/opentofu --json tagName --jq '.tagName' | sed 's/^v//')
TERRAGRUNT_VERSION=$(gh release view --repo gruntwork-io/terragrunt --json tagName --jq '.tagName' | sed 's/^v//')

echo "   OpenTofu:   ${OPENTOFU_VERSION}"
echo "   Terragrunt: ${TERRAGRUNT_VERSION}"
echo ""
echo "   Enter these values in the form below."

echo "opentofu_version=${OPENTOFU_VERSION}" >> "$RUNBOOK_OUTPUT"
echo "terragrunt_version=${TERRAGRUNT_VERSION}" >> "$RUNBOOK_OUTPUT"
