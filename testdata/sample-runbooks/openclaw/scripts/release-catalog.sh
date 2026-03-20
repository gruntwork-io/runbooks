#!/bin/bash
set -e

# Create a release on the infra-catalog repo.
#
# Environment variables:
#   - RUNBOOK_DRY_RUN: Set to "true" to print commands instead of executing them

DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

MODULE_NAME="{{ .inputs.ModuleName }}"
CATALOG_DIR="{{ .outputs.clone_catalog.CLONE_PATH }}"
RELEASE_TAG="{{ .inputs.ReleaseTag }}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "🏷️  Dry-run mode: Simulating release creation..."
    echo ""
    echo "[DRY-RUN] cd ${CATALOG_DIR}"
    echo "[DRY-RUN] git checkout main && git pull"
    echo "[DRY-RUN] gh release create ${RELEASE_TAG} --title '${RELEASE_TAG}' --notes 'Initial release with ${MODULE_NAME} module'"
    echo ""
    echo "✅ Dry-run completed successfully!"
    exit 0
fi

cd "${CATALOG_DIR}"

# Pull the latest main (PR was already merged)
git checkout main
git pull

echo "🏷️  Creating release ${RELEASE_TAG} on infra-catalog..."
echo ""

gh release create "${RELEASE_TAG}" \
  --title "${RELEASE_TAG}" \
  --notes "Initial release with ${MODULE_NAME} module."

echo ""
echo "✅ Release ${RELEASE_TAG} created!"
