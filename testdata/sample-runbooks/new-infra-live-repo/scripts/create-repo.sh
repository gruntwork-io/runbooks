#!/bin/bash
set -e

# Create a new GitHub repository for infra-live. The Command's env prop sets
# REPO_NAME and ORG_NAME from its inputs.

DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "📦 Dry-run mode: Simulating repo creation..."
    echo ""
    echo "[DRY-RUN] gh repo create ${ORG_NAME}/${REPO_NAME} --private --description 'Infrastructure live configurations'"
    echo ""
    echo "✅ Dry-run completed successfully!"
    exit 0
fi

echo "📦 Creating repository ${ORG_NAME}/${REPO_NAME}..."
echo ""

if gh repo view "${ORG_NAME}/${REPO_NAME}" &>/dev/null; then
    echo "ℹ️  Repository ${ORG_NAME}/${REPO_NAME} already exists. Skipping creation."
else
    gh repo create "${ORG_NAME}/${REPO_NAME}" \
        --private \
        --description "Infrastructure live configurations" \
        --clone=false
    echo ""
    echo "✅ Repository created: https://github.com/${ORG_NAME}/${REPO_NAME}"
fi

echo "repo_url=https://github.com/${ORG_NAME}/${REPO_NAME}" >> "$RUNBOOK_OUTPUT"
