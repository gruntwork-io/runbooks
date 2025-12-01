#!/bin/bash

set -e

################################################################################
# Script: import-cert.sh
# Description: Imports the macOS developer certificate into the system keychain.
#              Creates a temporary keychain, imports the P12 certificate, and
#              downloads the Apple root certificate for validation. This is a
#              one-time setup step before signing binaries.
#
# Usage: import-cert.sh [--macos-skip-root-certificate]
#
# Required Environment Variables:
#   MACOS_CERTIFICATE: macOS developer certificate in P12 format (base64 encoded)
#   MACOS_CERTIFICATE_PASSWORD: macOS certificate password
#
# Optional Arguments:
#   --macos-skip-root-certificate: Skip importing Apple Root certificate
################################################################################

# Apple certificate used to validate developer certificates https://www.apple.com/certificateauthority/
readonly APPLE_ROOT_CERTIFICATE="http://certs.apple.com/devidg2.der"

function print_usage {
  echo
  echo "Usage: $0 [OPTIONS]"
  echo
  echo "Required Environment Variables:"
  echo -e "  MACOS_CERTIFICATE\t\tmacOS developer certificate in P12 format, encoded in base64."
  echo -e "  MACOS_CERTIFICATE_PASSWORD\tmacOS certificate password"
  echo
  echo "Optional Arguments:"
  echo -e "  --macos-skip-root-certificate\t\tSkip importing Apple Root certificate. Useful when running in already configured environment."
  echo -e "  --help\t\t\t\tShow this help text and exit."
}

function main {
  local mac_skip_root_certificate=""

  while [[ $# -gt 0 ]]; do
    local key="$1"
    case "$key" in
      --macos-skip-root-certificate)
        mac_skip_root_certificate=true
        shift
        ;;
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
        echo "ERROR: Unexpected positional argument: $1"
        print_usage
        exit 1
        ;;
    esac
  done

  ensure_macos
  import_certificate_mac "${mac_skip_root_certificate}"
}

function ensure_macos {
  if [[ $OSTYPE != 'darwin'* ]]; then
    echo -e "Certificate import is supported only on macOS"
    exit 1
  fi
}

function import_certificate_mac {
  local -r mac_skip_root_certificate="$1"
  assert_env_var_not_empty "MACOS_CERTIFICATE"
  assert_env_var_not_empty "MACOS_CERTIFICATE_PASSWORD"

  local mac_certificate_pwd="${MACOS_CERTIFICATE_PASSWORD}"
  local keystore_pw="${RANDOM}"

  # Create temp file for the P12 certificate (importing from stdin can be unreliable)
  local p12_file
  p12_file=$(mktemp "/tmp/cert-XXXXXX.p12")
  echo "${MACOS_CERTIFICATE}" | base64 -d > "${p12_file}"
  
  # Cleanup trap for both keychain and cert file
  trap "rm -rf /tmp/*-keychain /tmp/cert-*.p12" EXIT

  # Create separated keychain file to store certificate
  local db_file
  db_file=$(mktemp "/tmp/XXXXXX-keychain")
  rm -rf "${db_file}"
  echo "Creating separated keychain for certificate"
  security create-keychain -p "${keystore_pw}" "${db_file}"
  
  # Set keychain to not lock and not timeout
  security set-keychain-settings "${db_file}"
  
  security unlock-keychain -p "${keystore_pw}" "${db_file}"
  
  # Add the keychain to the search list FIRST (before import)
  # Get current keychains, add new one at the front
  local current_keychains
  current_keychains=$(security list-keychains -d user | sed -e 's/"//g' | tr '\n' ' ')
  security list-keychains -d user -s "${db_file}" ${current_keychains}
  
  # Set as default keychain
  security default-keychain -s "${db_file}"
  
  echo "Keychain search list:"
  security list-keychains -d user
  
  # Import certificate from file (more reliable than stdin)
  echo "Importing P12 certificate..."
  security import "${p12_file}" -f pkcs12 -k "${db_file}" -P "${mac_certificate_pwd}" -T /usr/bin/codesign -T /usr/bin/security -A
  
  # Clean up P12 file immediately after import
  rm -f "${p12_file}"
  
  if [[ "${mac_skip_root_certificate}" == "" ]]; then
    # Download Apple root certificate used as root for developer certificate
    curl -v "${APPLE_ROOT_CERTIFICATE}" --output certificate.der
    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certificate.der
  fi
  
  # Set partition list to allow codesign and other tools to access the key
  # This must be done AFTER import
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${keystore_pw}" "${db_file}"
  
  echo ""
  echo "Verifying certificate import..."
  echo "Available codesigning identities:"
  security find-identity -v -p codesigning
  
  echo ""
  echo "Certificates in keychain:"
  security find-certificate -a -c "Gruntwork" "${db_file}" 2>/dev/null || echo "  (no certificates matching 'Gruntwork' found)"
  
  echo ""
  echo "Certificate imported successfully"
}

function assert_env_var_not_empty {
  local -r var_name="$1"
  local -r var_value="${!var_name}"

  if [[ -z "$var_value" ]]; then
    echo "ERROR: Required environment variable $var_name not set."
    exit 1
  fi
}

main "$@"

