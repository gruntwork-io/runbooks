#!/bin/bash
# Creates an S3 bucket with organization-standard tags

set -e

ACCOUNT_NAME="{{ .inputs.AccountName }}"
ORG_PREFIX="{{ .inputs.OrgNamePrefix }}"
REGION="{{ .inputs.DefaultRegion }}"
ENVIRONMENT="{{ .inputs.AccountEnvironment }}"
BUCKET_NAME="${ORG_PREFIX}-${ACCOUNT_NAME}-tags"

log_info "=== Creating Tags Standard Bucket ==="
log_info "Bucket name:  $BUCKET_NAME"
log_info "Region:       $REGION"
log_info "Environment:  $ENVIRONMENT"

# Check if bucket already exists
if aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
  log_warn "Bucket $BUCKET_NAME already exists. Skipping creation."
  echo "tags_bucket_name=$BUCKET_NAME" >> "$RUNBOOK_OUTPUT"
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

# Apply organization-standard tags
log_info "Applying organization-standard tags..."
aws s3api put-bucket-tagging \
  --bucket "$BUCKET_NAME" \
  --tagging "TagSet=[
    {Key=ManagedBy,Value=runbooks},
    {Key=Team,Value=platform-engineering},
    {Key=Environment,Value=${ENVIRONMENT}},
    {Key=Account,Value=${ACCOUNT_NAME}},
    {Key=OrgPrefix,Value=${ORG_PREFIX}},
    {Key=CostCenter,Value=infrastructure},
    {Key=DataClassification,Value=internal}
  ]"

log_info "Tags applied"

# Write a sample object to the bucket
log_info "Writing sample tagging policy document..."
cat > /tmp/tagging-policy.json <<EOF
{
  "version": "1.0",
  "org_prefix": "${ORG_PREFIX}",
  "required_tags": [
    "ManagedBy",
    "Team",
    "Environment",
    "CostCenter"
  ],
  "optional_tags": [
    "DataClassification",
    "Project",
    "Owner"
  ]
}
EOF

aws s3 cp /tmp/tagging-policy.json "s3://${BUCKET_NAME}/tagging-policy.json"
rm -f /tmp/tagging-policy.json

log_info "Tagging policy document uploaded"

# Write outputs
echo "tags_bucket_name=$BUCKET_NAME" >> "$RUNBOOK_OUTPUT"

log_info ""
log_info "=== Tags Bucket Created Successfully ==="
log_info "Bucket: $BUCKET_NAME"
log_info "Tags applied: ManagedBy, Team, Environment, Account, OrgPrefix, CostCenter, DataClassification"

exit 0
