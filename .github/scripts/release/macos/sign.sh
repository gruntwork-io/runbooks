#!/bin/bash

set -euo pipefail

################################################################################
# Script: sign.sh
# Description: Signs macOS binaries using gon and the provided configuration
#              files. Gon handles code signing and Apple notarization. This
#              script can sign multiple binaries in a single invocation.
#
# Usage: sign.sh <gon-config-file> [<gon-config-file>...]
#
# Arguments:
#   gon-config-file: Path to gon configuration file(s) in HCL format
#
# Examples:
#   sign.sh .gon_amd64.hcl
#   sign.sh .gon_amd64.hcl .gon_arm64.hcl
################################################################################

function print_usage {
  echo
  echo "Usage: $0 <gon-config-file> [<gon-config-file>...]"
  echo
  echo "Signs binaries using gon and provided configuration files."
  echo
  echo "Arguments:"
  echo -e "  <gon-config-file>\t\tPath to gon configuration file (HCL format)"
  echo
  echo "Optional Arguments:"
  echo -e "  --help\t\t\tShow this help text and exit."
  echo
  echo "Examples:"
  echo "  $0 .gon_amd64.hcl"
  echo "  $0 .gon_amd64.hcl .gon_arm64.hcl"
}

function main {
  local config_files=()

  while [[ $# -gt 0 ]]; do
    local key="$1"
    case "$key" in
      --help)
        print_usage
        exit
        ;;
      -* )
        echo "ERROR: Unrecognized argument: $key"
        print_usage
        exit 1
        ;;
      * )
        config_files=("$@")
        break
    esac
  done

  if [[ ${#config_files[@]} -eq 0 ]]; then
    echo "ERROR: At least one gon configuration file must be provided"
    print_usage
    exit 1
  fi

  ensure_macos
  sign_with_gon "${config_files[@]}"
}

function ensure_macos {
  if [[ $OSTYPE != 'darwin'* ]]; then
    echo -e "Signing of macOS binaries is supported only on macOS"
    exit 1
  fi
}

function sign_with_gon {
  local -r config_files=("$@")
  local gon_cmd="gon"
  
  for filepath in "${config_files[@]}"; do
    echo "Signing ${filepath}"
    local log_file="/tmp/gon-$(basename "${filepath}").log"
    
    # Use debug log level to capture notarization submission IDs for debugging
    "${gon_cmd}" -log-level=debug "${filepath}" 2>&1 | tee "${log_file}" || {
      echo ""
      echo "❌ Signing/notarization failed for ${filepath}"
      
      # Try to extract submission ID from logs
      local submission_id
      submission_id=$(grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' "${log_file}" | tail -1 || true)
      
      if [[ -n "${submission_id}" ]]; then
        echo ""
        echo "📋 Submission ID: ${submission_id}"
        echo ""
        echo "To get detailed notarization logs, run:"
        echo "  xcrun notarytool log ${submission_id} --apple-id \"\$AC_USERNAME\" --password \"\$AC_PASSWORD\" --team-id \"\$AC_PROVIDER\""
      else
        echo ""
        echo "⚠️  No submission ID found - the request likely failed before Apple created a submission."
        echo "   This usually means an authentication error (check AC_USERNAME, AC_PASSWORD, AC_PROVIDER)."
      fi
      echo ""
      exit 1
    }
  done
}

main "$@"

