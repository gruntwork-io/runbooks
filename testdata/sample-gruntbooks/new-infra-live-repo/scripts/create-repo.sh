#!/bin/bash
set -e

# Create a new GitHub repository for infra-live.

DRY_RUN="${GRUNTBOOK_DRY_RUN:-false}"

REPO_NAME="{{ .inputs.RepoName }}"
ORG_NAME="{{ .inputs.OrgName }}"

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

echo "repo_url=https://github.com/${ORG_NAME}/${REPO_NAME}" >> "$GRUNTBOOK_OUTPUT"
