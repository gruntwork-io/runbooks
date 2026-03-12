#!/bin/bash
# Verify that we're authenticated to a management account

set -e

log_info "Verifying management account authentication..."

IDENTITY=$(aws sts get-caller-identity --output json 2>&1) || {
  log_error "Failed to call STS. Are you authenticated?"
  exit 1
}

ACCOUNT_ID=$(echo "$IDENTITY" | jq -r '.Account')
ARN=$(echo "$IDENTITY" | jq -r '.Arn')

log_info "Authenticated as: $ARN"
log_info "Account ID: $ACCOUNT_ID"

# Write outputs for downstream use
echo "mgmt_account_id=$ACCOUNT_ID" >> "$RUNBOOK_OUTPUT"
echo "mgmt_arn=$ARN" >> "$RUNBOOK_OUTPUT"

# Check if this account is an Organizations management account
log_info "Checking if this is an AWS Organizations management account..."

ORG_INFO=$(aws organizations describe-organization --output json 2>&1) || {
  log_warn "Could not describe organization. This may not be a management account, but proceeding anyway."
  exit 0
}

MASTER_ACCOUNT_ID=$(echo "$ORG_INFO" | jq -r '.Organization.MasterAccountId')

if [ "$ACCOUNT_ID" = "$MASTER_ACCOUNT_ID" ]; then
  log_info "Confirmed: This is the AWS Organizations management account."
else
  log_warn "This account ($ACCOUNT_ID) is not the management account ($MASTER_ACCOUNT_ID). Proceeding anyway for demo purposes."
  exit 2
fi

exit 0
