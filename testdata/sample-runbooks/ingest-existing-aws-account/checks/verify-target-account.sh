#!/bin/bash
# Verify authentication to the target account

set -e

EXPECTED_ACCOUNT_ID="{{ .inputs.AccountId }}"

log_info "Verifying target account authentication..."

IDENTITY=$(aws sts get-caller-identity --output json 2>&1) || {
  log_error "Failed to call STS. Are you authenticated to the target account?"
  exit 1
}

ACTUAL_ACCOUNT_ID=$(echo "$IDENTITY" | jq -r '.Account')
ARN=$(echo "$IDENTITY" | jq -r '.Arn')

log_info "Authenticated as: $ARN"
log_info "Account ID: $ACTUAL_ACCOUNT_ID"

if [ "$ACTUAL_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then
  log_error "Account ID mismatch!"
  log_error "Expected: $EXPECTED_ACCOUNT_ID"
  log_error "Got:      $ACTUAL_ACCOUNT_ID"
  log_error "Please authenticate to the correct target account."
  exit 1
fi

log_info "Account ID matches expected value: $EXPECTED_ACCOUNT_ID"
exit 0
