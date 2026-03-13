#!/bin/bash
set -e

# Verify OpenClaw deployment is running
# Template variables: InstanceName, Environment, AwsRegion
#
# Environment variables:
#   - RUNBOOK_DRY_RUN: Set to "true" to print commands instead of executing them

# Dry-run support
DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

INSTANCE_NAME="{{ .inputs.InstanceName }}-{{ .inputs.Environment }}"
AWS_REGION="{{ .inputs.AwsRegion }}"
GATEWAY_PORT="{{ .inputs.GatewayPort }}"

# In dry-run mode, simulate the checks
if [[ "$DRY_RUN" == "true" ]]; then
    echo "🧪 Dry-run mode: Simulating OpenClaw verification..."
    echo ""
    echo "[DRY-RUN] aws sts get-caller-identity"
    echo "[DRY-RUN] aws ec2 describe-instances --filters Name=tag:Name,Values=$INSTANCE_NAME --region $AWS_REGION"
    echo ""
    echo "📝 Would verify:"
    echo "   Instance: ${INSTANCE_NAME}"
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
  echo "   You need valid AWS credentials to verify the deployment."
  echo ""

  if command -v assume &> /dev/null; then
    echo "   Use Granted to assume a role:"
    echo "     assume <profile-name>"
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

echo "✅ Authenticated to AWS"
echo ""

# Check the EC2 instance is running
echo "🔍 Checking EC2 instance status..."

INSTANCE_INFO=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=running" \
  --region "$AWS_REGION" \
  --query "Reservations[0].Instances[0].[InstanceId,PublicIpAddress,State.Name]" \
  --output text 2>/dev/null)

if [ -z "$INSTANCE_INFO" ] || [ "$INSTANCE_INFO" = "None" ]; then
    echo "❌ No running instance found with name: ${INSTANCE_NAME}"
    echo ""
    echo "   Possible causes:"
    echo "   - The instance hasn't been deployed yet (run terragrunt apply first)"
    echo "   - The instance is in a different region"
    echo "   - The instance is stopped or terminated"
    exit 1
fi

INSTANCE_ID=$(echo "$INSTANCE_INFO" | awk '{print $1}')
PUBLIC_IP=$(echo "$INSTANCE_INFO" | awk '{print $2}')
STATE=$(echo "$INSTANCE_INFO" | awk '{print $3}')

echo "✅ Instance is running!"
echo "   Instance ID: $INSTANCE_ID"
echo "   Public IP: $PUBLIC_IP"
echo "   State: $STATE"
echo ""

# Check if Tailscale is available locally
if command -v tailscale &> /dev/null; then
    echo "🔍 Checking Tailscale connectivity..."
    TAILSCALE_STATUS=$(tailscale status 2>/dev/null || true)

    if echo "$TAILSCALE_STATUS" | grep -qi "${INSTANCE_NAME}"; then
        TAILSCALE_IP=$(echo "$TAILSCALE_STATUS" | grep -i "${INSTANCE_NAME}" | awk '{print $1}')
        echo "✅ OpenClaw node found on Tailnet!"
        echo "   Tailscale IP: $TAILSCALE_IP"
        echo ""
        echo "   Access OpenClaw at: http://${TAILSCALE_IP}:${GATEWAY_PORT}"
        echo ""
        echo "   Retrieve the gateway token:"
        echo "     ssh ubuntu@${TAILSCALE_IP} cat /home/ubuntu/.openclaw-token"
    else
        echo "⚠️  OpenClaw node not found on your Tailnet yet."
        echo "   The instance may still be initializing (cloud-init can take 2-3 minutes)."
        echo ""
        echo "   Try again in a minute, or check the Tailscale admin console:"
        echo "   https://login.tailscale.com/admin/machines"
    fi
else
    echo "ℹ️  Tailscale is not installed on this machine."
    echo "   Install it to access OpenClaw securely:"
    echo "   - macOS: brew install tailscale"
    echo "   - Linux: curl -fsSL https://tailscale.com/install.sh | sh"
    echo ""
    echo "   Alternatively, you can SSH to the instance:"
    echo "   ssh -i ~/.ssh/<your-key>.pem ubuntu@${PUBLIC_IP}"
fi

echo ""
echo "🎉 OpenClaw deployment verified successfully!"
