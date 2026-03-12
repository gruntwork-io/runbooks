#!/bin/bash
# Verify all AWS resources created during the runbook

set -e

ACCOUNT_NAME="{{ .inputs.AccountName }}"
ORG_PREFIX="{{ .inputs.OrgNamePrefix }}"
STATE_BUCKET="${ORG_PREFIX}-${ACCOUNT_NAME}-tf-state"
TAGS_BUCKET="${ORG_PREFIX}-${ACCOUNT_NAME}-tags"
REGION="{{ .inputs.DefaultRegion }}"

log_info "Verifying AWS resources in account {{ .inputs.AccountId }}..."

ERRORS=0

# Check state bucket
log_info "Checking state bucket: $STATE_BUCKET"
if aws s3api head-bucket --bucket "$STATE_BUCKET" 2>/dev/null; then
  log_info "State bucket exists"
else
  log_error "State bucket $STATE_BUCKET not found"
  ERRORS=$((ERRORS + 1))
fi

# Check tags bucket
log_info "Checking tags bucket: $TAGS_BUCKET"
if aws s3api head-bucket --bucket "$TAGS_BUCKET" 2>/dev/null; then
  log_info "Tags bucket exists"
else
  log_error "Tags bucket $TAGS_BUCKET not found"
  ERRORS=$((ERRORS + 1))
fi

# List all buckets for reference
log_info "All S3 buckets in this account:"
aws s3 ls

if [ "$ERRORS" -gt 0 ]; then
  log_error "$ERRORS resource(s) could not be verified"
  exit 1
fi

log_info "All resources verified successfully!"
exit 0
