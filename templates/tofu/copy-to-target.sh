#!/usr/bin/env bash
# Copy generated terragrunt.hcl to the target repository location.
# Expected environment variables (from deploy-config inputs):
#   GENERATED_FILES - directory containing rendered output
#   REPO_FILES      - root of the cloned target repository
#   TargetPath      - subdirectory within the repo to place the file

set -euo pipefail

TARGET_DIR="${REPO_FILES}/${TargetPath}"

mkdir -p "${TARGET_DIR}"
cp "${GENERATED_FILES}/terragrunt.hcl" "${TARGET_DIR}/terragrunt.hcl"

echo "Copied terragrunt.hcl to ${TARGET_DIR}"
