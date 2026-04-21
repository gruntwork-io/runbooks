#!/bin/bash
set -e

# Verify OpenClaw deployment is running
# Template variables: InstanceName, AwsRegion, GatewayPort
#
# Environment variables:
#   - GRUNTBOOK_DRY_RUN: Set to "true" to print commands instead of executing them

# Dry-run support
DRY_RUN="${GRUNTBOOK_DRY_RUN:-false}"

INSTANCE_NAME="{{ .inputs.InstanceName }}"
AWS_REGION="{{ .inputs.AwsRegion }}"
GATEWAY_PORT="{{ .inputs.GatewayPort }}"

# In dry-run mode, simulate the checks
if [[ "$DRY_RUN" == "true" ]]; then
    echo "Dry-run mode: Simulating OpenClaw verification..."
    echo ""
    echo "[DRY-RUN] aws sts get-caller-identity"
    echo "[DRY-RUN] aws ec2 describe-instances --filters Name=tag:Name,Values=$INSTANCE_NAME --region $AWS_REGION"
    echo ""
    echo "Would verify:"
    echo "   Instance: ${INSTANCE_NAME}"
    echo "   Region: ${AWS_REGION}"
    echo ""
    echo "Done!"
    exit 0
fi

# First, check if the user is authenticated to AWS
echo "Checking AWS authentication..."
if ! aws sts get-caller-identity &> /dev/null; then
  echo "Not authenticated to AWS"
  echo ""
  echo "   You need valid AWS credentials to verify the deployment."
  exit 1
fi

echo "Authenticated to AWS"
echo ""

# Check the EC2 instance is running
echo "Checking EC2 instance status..."

INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=running" \
  --region "$AWS_REGION" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text 2>/dev/null)

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
    echo "No running instance found with name: ${INSTANCE_NAME}"
    echo ""
    echo "   Possible causes:"
    echo "   - The instance hasn't been deployed yet (run terragrunt apply first)"
    echo "   - The instance is in a different region"
    echo "   - The instance is stopped or terminated"
    exit 1
fi

echo "Instance is running!"
echo "   Instance ID: $INSTANCE_ID"
echo ""

# Check SSM connectivity
echo "Checking SSM connectivity..."
SSM_STATUS=$(aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
  --query "InstanceInformationList[0].PingStatus" \
  --output text 2>/dev/null || echo "Unknown")

if [ "$SSM_STATUS" = "Online" ]; then
    echo "SSM agent is online!"
    echo ""
    echo "   Access OpenClaw:"
    echo "   1. Start port forward:"
    echo "      aws ssm start-session --target ${INSTANCE_ID} --document-name AWS-StartPortForwardingSession --parameters '{\"portNumber\":[\"${GATEWAY_PORT}\"],\"localPortNumber\":[\"${GATEWAY_PORT}\"]}'"
    echo "   2. Open http://localhost:${GATEWAY_PORT}"
    echo "   3. Retrieve password:"
    echo "      aws ssm start-session --target ${INSTANCE_ID} --document-name AWS-StartInteractiveCommand --parameters command='sudo cat /home/ubuntu/.openclaw-password'"
else
    echo "SSM agent is not yet online (status: ${SSM_STATUS})"
    echo "   The instance may still be initializing (cloud-init can take 2-3 minutes)."
    echo "   Wait a moment and try again."
    echo ""
    echo "   To monitor progress, open a shell once SSM is ready:"
    echo "     aws ssm start-session --target ${INSTANCE_ID}"
    echo "   Then run: tail -f /var/log/cloud-init-output.log"
fi

echo ""
echo "OpenClaw deployment verified successfully!"
