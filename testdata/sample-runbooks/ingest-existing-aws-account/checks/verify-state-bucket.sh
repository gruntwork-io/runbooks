#!/bin/bash
# Verify the state bucket exists and is properly configured

set -e

ACCOUNT_NAME="{{ .inputs.AccountName }}"
ORG_PREFIX="{{ .inputs.OrgNamePrefix }}"
BUCKET_NAME="${ORG_PREFIX}-${ACCOUNT_NAME}-tf-state"
REGION="{{ .inputs.DefaultRegion }}"

log_info "Verifying state bucket: $BUCKET_NAME"

# Check bucket exists
if ! aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
  log_error "Bucket $BUCKET_NAME does not exist"
  exit 1
fi

log_info "Bucket exists"

# Check versioning
VERSIONING=$(aws s3api get-bucket-versioning --bucket "$BUCKET_NAME" --query 'Status' --output text 2>/dev/null)
if [ "$VERSIONING" = "Enabled" ]; then
  log_info "Versioning is enabled"
else
  log_warn "Versioning is not enabled (Status: $VERSIONING)"
fi

# Check encryption
ENCRYPTION=$(aws s3api get-bucket-encryption --bucket "$BUCKET_NAME" --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text 2>/dev/null) || {
  log_warn "Could not verify encryption configuration"
  exit 2
}

if [ "$ENCRYPTION" = "aws:kms" ] || [ "$ENCRYPTION" = "AES256" ]; then
  log_info "Server-side encryption is enabled: $ENCRYPTION"
else
  log_warn "Unexpected encryption configuration: $ENCRYPTION"
  exit 2
fi

# Check public access block
PUBLIC_ACCESS=$(aws s3api get-public-access-block --bucket "$BUCKET_NAME" --output json 2>/dev/null) || {
  log_warn "Could not verify public access block"
  exit 2
}

BLOCK_ALL=$(echo "$PUBLIC_ACCESS" | jq '.PublicAccessBlockConfiguration | .BlockPublicAcls and .IgnorePublicAcls and .BlockPublicPolicy and .RestrictPublicBuckets')
if [ "$BLOCK_ALL" = "true" ]; then
  log_info "Public access is fully blocked"
else
  log_warn "Public access block is not fully configured"
  exit 2
fi

log_info "State bucket $BUCKET_NAME is properly configured!"
exit 0
