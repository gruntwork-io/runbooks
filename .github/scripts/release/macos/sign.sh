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
    # Use debug log level to capture notarization submission IDs for debugging
    "${gon_cmd}" -log-level=debug "${filepath}" 2>&1 | tee "/tmp/gon-$(basename "${filepath}").log" || {
      echo ""
      echo "❌ Signing/notarization failed for ${filepath}"
      echo "To debug, get the submission ID from the logs above and run:"
      echo "  xcrun notarytool log <submission-id> --apple-id \"\$AC_USERNAME\" --password \"\$AC_PASSWORD\" --team-id \"\$AC_PROVIDER\""
      echo ""
      # Also try to extract and display the submission ID
      grep -o 'id: [a-f0-9-]\{36\}' "/tmp/gon-$(basename "${filepath}").log" | tail -1 || true
      exit 1
    }
  done
}

main "$@"

