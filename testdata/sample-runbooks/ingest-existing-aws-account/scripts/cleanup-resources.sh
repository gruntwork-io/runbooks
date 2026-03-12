#!/bin/bash
# Clean up demo resources created by this runbook

set -e

ACCOUNT_NAME="{{ .inputs.AccountName }}"
ORG_PREFIX="{{ .inputs.OrgNamePrefix }}"
STATE_BUCKET="${ORG_PREFIX}-${ACCOUNT_NAME}-tf-state"
TAGS_BUCKET="${ORG_PREFIX}-${ACCOUNT_NAME}-tags"

log_info "=== Cleaning Up Demo Resources ==="
log_warn "This will permanently delete the following resources:"
log_warn "  - S3 Bucket: $STATE_BUCKET"
log_warn "  - S3 Bucket: $TAGS_BUCKET"

# Delete tags bucket
log_info ""
log_info "Deleting tags bucket: $TAGS_BUCKET"
if aws s3api head-bucket --bucket "$TAGS_BUCKET" 2>/dev/null; then
  # Empty the bucket first
  log_info "  Emptying bucket..."
  aws s3 rm "s3://${TAGS_BUCKET}" --recursive 2>/dev/null || true

  # Delete the bucket
  log_info "  Deleting bucket..."
  aws s3api delete-bucket --bucket "$TAGS_BUCKET"
  log_info "  Bucket $TAGS_BUCKET deleted"
else
  log_info "  Bucket $TAGS_BUCKET does not exist, skipping"
fi

# Delete state bucket
log_info ""
log_info "Deleting state bucket: $STATE_BUCKET"
if aws s3api head-bucket --bucket "$STATE_BUCKET" 2>/dev/null; then
  # Empty the bucket first (including versioned objects)
  log_info "  Emptying bucket (including versions)..."
  aws s3api list-object-versions --bucket "$STATE_BUCKET" --output json 2>/dev/null | \
    jq -r '.Versions[]? | "--key \"\(.Key)\" --version-id \(.VersionId)"' | \
    while read -r args; do
      eval aws s3api delete-object --bucket "$STATE_BUCKET" "$args" 2>/dev/null || true
    done

  aws s3api list-object-versions --bucket "$STATE_BUCKET" --output json 2>/dev/null | \
    jq -r '.DeleteMarkers[]? | "--key \"\(.Key)\" --version-id \(.VersionId)"' | \
    while read -r args; do
      eval aws s3api delete-object --bucket "$STATE_BUCKET" "$args" 2>/dev/null || true
    done

  # Delete the bucket
  log_info "  Deleting bucket..."
  aws s3api delete-bucket --bucket "$STATE_BUCKET"
  log_info "  Bucket $STATE_BUCKET deleted"
else
  log_info "  Bucket $STATE_BUCKET does not exist, skipping"
fi

log_info ""
log_info "=== Cleanup Complete ==="
log_info "All demo resources have been removed."

exit 0
