#!/bin/bash
set -e

# Create a release on the infra-catalog repo.
#
# Environment variables:
#   - RUNBOOK_DRY_RUN: Set to "true" to print commands instead of executing them

DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

MODULE_NAME="{{ .inputs.ModuleName }}"
CATALOG_DIR="{{ .outputs.clone_catalog.clone_path }}"
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

# Pull the latest main (PR was already merged). GitClone keeps the token out of
# the checkout's git config, so authenticate this pull with the GITHUB_TOKEN the
# GitHub Auth block exported. The helper reads it when git asks, which keeps the
# token off the command line.
git checkout main
git -c credential.helper= \
  -c 'credential.helper=!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f' \
  pull

echo "🏷️  Creating release ${RELEASE_TAG} on infra-catalog..."
echo ""

gh release create "${RELEASE_TAG}" \
  --title "${RELEASE_TAG}" \
  --notes "Initial release with ${MODULE_NAME} module."

echo ""
echo "✅ Release ${RELEASE_TAG} created!"
