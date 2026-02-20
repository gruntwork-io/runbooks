#!/usr/bin/env bash
# Place the generated terragrunt.hcl into the cloned target repository.
# Environment variables (set automatically by Runbooks):
#   REPO_FILES  - root of the cloned target repository
# Template variables (from deploy-config inputs):
#   TargetPath  - subdirectory within the repo to place the file
# Template variables (from module-vars via _module namespace):
#   _module.source, _module.hcl_inputs - module data for generating HCL

set -euo pipefail

TARGET_DIR="${REPO_FILES}/{{ .TargetPath }}"
mkdir -p "${TARGET_DIR}"

cat > "${TARGET_DIR}/terragrunt.hcl" << 'RUNBOOK_HCL_EOF'
terraform {
  source = "{{ ._module.source }}"
}

include "root" {
  path   = find_in_parent_folders("root.hcl")
  expose = true
}

inputs = {
{{- range $name, $hcl := ._module.hcl_inputs }}
  {{ $name }} = {{ $hcl }}
{{- end }}
}
RUNBOOK_HCL_EOF

echo "Placed terragrunt.hcl in ${TARGET_DIR}"
