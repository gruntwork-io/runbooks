#!/bin/bash
set -e

# Run terragrunt destroy for the OpenClaw deployment
# Template variables from openclaw-config:
#   - InstanceName -> OpenClaw instance name
#   - Environment -> Target environment
#   - AwsRegion -> AWS region
#
# Environment variables:
#   - RUNBOOK_DRY_RUN: Set to "true" to print commands instead of executing them

# Dry-run support
DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

INSTANCE_NAME="{{ .inputs.InstanceName }}"
ENVIRONMENT="{{ .inputs.Environment }}"
AWS_REGION="{{ .inputs.AwsRegion }}"

GENERATED_DIR="generated"

# In dry-run mode, skip AWS auth check and simulate the rest
if [[ "$DRY_RUN" == "true" ]]; then
    echo "🗑️  Dry-run mode: Simulating terragrunt destroy..."
    echo ""
    echo "[DRY-RUN] aws sts get-caller-identity"
    echo "[DRY-RUN] cd ${GENERATED_DIR}"
    echo "[DRY-RUN] terragrunt run --backend-bootstrap --non-interactive -- destroy -auto-approve"
    echo ""
    echo "📝 Destroy would remove all resources for:"
    echo "   Instance: ${INSTANCE_NAME}-${ENVIRONMENT}"
    echo "   Region: ${AWS_REGION}"
    echo ""
    echo "✅ Dry-run completed successfully!"
    exit 0
fi

# First, check if the user is authenticated to AWS
echo "🔐 Checking AWS authentication..."
if ! aws sts get-caller-identity &> /dev/null; then
  echo "❌ Not authenticated to AWS"
  echo ""
  echo "   You need valid AWS credentials to run terragrunt destroy."
  echo ""

  # Check if granted is installed and recommend it
  if command -v assume &> /dev/null; then
    echo "   Use Granted to assume a role:"
    echo "     assume <profile-name>"
    echo ""
    echo "   Example:"
    echo "     assume sandbox"
    echo ""
    echo "   List available profiles:"
    echo "     assume --list"
  else
    echo "   Option 1: Install Granted (recommended)"
    echo "     brew tap common-fate/granted && brew install granted"
    echo "     assume <profile-name>"
    echo ""
    echo "   Option 2: Use AWS CLI directly"
    echo "     aws sso login --profile <profile-name>"
    echo "     export AWS_PROFILE=<profile-name>"
  fi
  exit 1
fi

# Get the identity info
IDENTITY=$(aws sts get-caller-identity --output json 2>/dev/null)
ACCOUNT=$(echo "$IDENTITY" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
ARN=$(echo "$IDENTITY" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4)

echo "✅ Authenticated to AWS"
echo "   Account: $ACCOUNT"
echo "   Identity: $ARN"
echo ""

# Check if generated directory exists
if [ ! -d "${GENERATED_DIR}" ]; then
    echo "❌ Error: Generated directory not found at ${GENERATED_DIR}"
    echo "   Please make sure you've generated the files first."
    exit 1
fi

# Run terragrunt destroy
echo "🗑️  Running terragrunt destroy for: ${INSTANCE_NAME}-${ENVIRONMENT} in ${AWS_REGION}..."
echo "   Path: ${GENERATED_DIR}"
echo ""
echo "   This will destroy:"
echo "   - EC2 instance and key pair"
echo "   - Elastic IP"
echo "   - Security group"
echo "   - VPC, subnet, internet gateway, and route table"
echo ""

cd "${GENERATED_DIR}"

if terragrunt run --backend-bootstrap --non-interactive -- destroy -auto-approve; then
  echo ""
  echo "✅ Terragrunt destroy completed successfully!"
  echo ""
  echo "   All OpenClaw resources have been removed from AWS."
  echo ""
  echo "   You may also want to:"
  echo "   1. Remove the saved SSH key: rm ~/.ssh/${INSTANCE_NAME}-${ENVIRONMENT}-key"
  echo "   2. Remove the node from Tailscale: https://login.tailscale.com/admin/machines"
  exit 0
else
  echo ""
  echo "❌ Terragrunt destroy failed"
  echo ""
  echo "   Possible causes:"
  echo "   - Missing or invalid configuration"
  echo "   - Insufficient IAM permissions"
  echo "   - Resource state issues"
  exit 1
fi
