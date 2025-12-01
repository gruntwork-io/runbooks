#!/bin/bash

set -e

################################################################################
# Script: sign-and-verify-binaries.sh
# Description: Orchestrates the complete macOS binary signing workflow. Imports
#              certificates, signs both amd64 and arm64 binaries using gon,
#              extracts signed binaries from ZIP files, verifies signatures with
#              codesign, and organizes files in the bin directory.
#
# Usage: sign-and-verify-binaries.sh <bin-dir>
#
# Arguments:
#   bin-dir: Directory containing binaries to sign (default: bin)
#
# Required Environment Variables:
#   AC_PASSWORD: Apple Connect password for notarization
#   AC_PROVIDER: Apple Connect provider
#   AC_USERNAME: Apple Connect username
#   MACOS_CERTIFICATE: macOS certificate in P12 format (base64 encoded)
#   MACOS_CERTIFICATE_PASSWORD: Certificate password
################################################################################

function main {
  local -r bin_dir="${1:-bin}"

  # Validate required environment variables
  : "${AC_PASSWORD:?ERROR: AC_PASSWORD is a required environment variable}"
  : "${AC_PROVIDER:?ERROR: AC_PROVIDER is a required environment variable}"
  : "${AC_USERNAME:?ERROR: AC_USERNAME is a required environment variable}"
  : "${MACOS_CERTIFICATE:?ERROR: MACOS_CERTIFICATE is a required environment variable}"
  : "${MACOS_CERTIFICATE_PASSWORD:?ERROR: MACOS_CERTIFICATE_PASSWORD is a required environment variable}"

  if [[ ! -d "$bin_dir" ]]; then
    echo "ERROR: Directory $bin_dir does not exist"
    exit 1
  fi

  echo "Importing macOS certificate..."
  .github/scripts/release/macos/import-cert.sh

  echo "Signing macOS binaries..."
  .github/scripts/release/macos/sign.sh .gon_amd64.hcl .gon_arm64.hcl

  echo "Done signing the binaries"

  # Source configuration library
  # shellcheck source=lib-release-config.sh
  source "$(dirname "$0")/../lib-release-config.sh"

  verify_config_file

  # Get list of macOS binaries from config
  local macos_binaries
  macos_binaries=$(get_binaries_for_os "darwin")

  echo "Expected macOS binaries from config: $macos_binaries"

  # Remove old unsigned binaries from bin directory
  echo "Removing unsigned binaries from $bin_dir..."
  for binary in $macos_binaries; do
    rm -f "$bin_dir/$binary"
    echo "  Removed: $bin_dir/$binary"
  done

  # Extract and verify signed binaries
  echo ""
  echo "Extracting and verifying signed binaries..."

  for binary in $macos_binaries; do
    local zip_file="${binary}.zip"

    echo "Processing $binary..."

    # Check ZIP file exists
    [[ -f "$zip_file" ]] || {
      echo "ERROR: ZIP file $zip_file not found for binary $binary"
      exit 1
    }

    echo "  Found $zip_file, extracting..."
    unzip -o "$zip_file"

    # Check extraction succeeded
    [[ -f "$binary" ]] || {
      echo "  ERROR: Failed to extract binary $binary from $zip_file"
      exit 1
    }

    echo "  Extracted binary exists, checking signature..."
    codesign -dv --verbose=4 "$binary" 2>&1 || {
      echo "  ERROR: Signature verification failed for binary $binary"
      exit 1
    }

    echo "  Signature verified"
    mv "$binary" "$bin_dir/"
    echo "  Moved signed binary to $bin_dir/"

    # Also move the ZIP file to bin directory
    mv "$zip_file" "$bin_dir/"
    echo "  Moved $zip_file to $bin_dir/"
    echo ""
  done

  # Final verification of all binaries in bin directory
  echo "Final verification of all binaries in $bin_dir..."
  for binary in $macos_binaries; do
    echo "Verifying $binary..."

    [[ -f "$bin_dir/$binary" ]] || {
      echo "ERROR: Binary $bin_dir/$binary not found after processing"
      exit 1
    }

    codesign -dv --verbose=4 "$bin_dir/$binary" || {
      echo "ERROR: Signature verification failed for binary $bin_dir/$binary"
      exit 1
    }
  done

  echo ""
  echo "All macOS binaries signed and verified successfully"

  # Show final contents of bin directory for debugging
  echo ""
  echo "Final contents of $bin_dir directory:"
  ls -lah "$bin_dir/"
}

main "$@"

