#!/bin/bash
# Creates an S3 bucket for Terraform/OpenTofu remote state

set -e

ACCOUNT_NAME="{{ .inputs.AccountName }}"
ORG_PREFIX="{{ .inputs.OrgNamePrefix }}"
REGION="{{ .inputs.DefaultRegion }}"
BUCKET_NAME="${ORG_PREFIX}-${ACCOUNT_NAME}-tf-state"

log_info "=== Creating Terraform State Bucket ==="
log_info "Bucket name: $BUCKET_NAME"
log_info "Region:      $REGION"

# Check if bucket already exists
if aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
  log_warn "Bucket $BUCKET_NAME already exists. Skipping creation."
  echo "state_bucket_name=$BUCKET_NAME" >> "$RUNBOOK_OUTPUT"
  echo "state_bucket_region=$REGION" >> "$RUNBOOK_OUTPUT"
  exit 0
fi

# Create the bucket
log_info "Creating S3 bucket..."
if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION"
else
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi

log_info "Bucket created"

# Enable versioning
log_info "Enabling versioning..."
aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled

log_info "Versioning enabled"

# Enable server-side encryption (AES256)
log_info "Enabling server-side encryption..."
aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      },
      "BucketKeyEnabled": true
    }]
  }'

log_info "Encryption enabled (AES256)"

# Block all public access
log_info "Blocking public access..."
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration '{
    "BlockPublicAcls": true,
    "IgnorePublicAcls": true,
    "BlockPublicPolicy": true,
    "RestrictPublicBuckets": true
  }'

log_info "Public access blocked"

# Add tags
log_info "Adding tags..."
aws s3api put-bucket-tagging \
  --bucket "$BUCKET_NAME" \
  --tagging "TagSet=[
    {Key=ManagedBy,Value=runbooks},
    {Key=Purpose,Value=terraform-state},
    {Key=Account,Value={{ .inputs.AccountName }}},
    {Key=Environment,Value={{ .inputs.AccountEnvironment }}}
  ]"

log_info "Tags applied"

# Write outputs
echo "state_bucket_name=$BUCKET_NAME" >> "$RUNBOOK_OUTPUT"
echo "state_bucket_region=$REGION" >> "$RUNBOOK_OUTPUT"

log_info ""
log_info "=== State Bucket Created Successfully ==="
log_info "Bucket: $BUCKET_NAME"
log_info "Region: $REGION"
log_info "Versioning: Enabled"
log_info "Encryption: AES256"
log_info "Public Access: Blocked"

exit 0
