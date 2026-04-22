#!/bin/bash
set -e

# Print the SSM connect and port forwarding commands after deployment.
#
# Environment variables:
#   - REPO_FILES: Path to the infra-live clone
#   - GRUNTBOOK_DRY_RUN: Set to "true" to print commands instead of executing them

DRY_RUN="${GRUNTBOOK_DRY_RUN:-false}"

INSTANCE_NAME="{{ .inputs.InstanceName }}"
GATEWAY_PORT="{{ .inputs.GatewayPort }}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "Dry-run mode: Simulating connection info..."
    echo ""
    echo "[DRY-RUN] cd \$REPO_FILES"
    echo "[DRY-RUN] terragrunt output -raw instance_id"
    echo ""
    echo "Done!"
    exit 0
fi

cd "${REPO_FILES}/{{ .inputs.AccountName }}/{{ .inputs.AwsRegion }}/{{ .inputs.ModuleName }}"

# Get instance ID from terragrunt output, fall back to AWS CLI
INSTANCE_ID=$(terragrunt output -raw instance_id 2>/dev/null || true)

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == *"No outputs"* ]]; then
    echo "Could not read instance_id from terragrunt output, trying AWS CLI..."
    INSTANCE_ID=$(aws ec2 describe-instances \
        --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=running" \
        --query 'Reservations[0].Instances[0].InstanceId' \
        --output text 2>/dev/null || true)
fi

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
    echo "Error: Could not determine instance ID"
    exit 1
fi

SSM_COMMAND="aws ssm start-session --target ${INSTANCE_ID}"
PORT_FORWARD_COMMAND="aws ssm start-session --target ${INSTANCE_ID} --document-name AWS-StartPortForwardingSession --parameters '{\"portNumber\":[\"${GATEWAY_PORT}\"],\"localPortNumber\":[\"${GATEWAY_PORT}\"]}'"
PASSWORD_COMMAND="aws ssm start-session --target ${INSTANCE_ID} --document-name AWS-StartInteractiveCommand --parameters command='sudo cat /home/ubuntu/.openclaw-password'"

echo ""
echo "OpenClaw instance deployed: ${INSTANCE_ID}"
echo ""
echo "   Start SSM port forward (run in a dedicated terminal):"
echo "     ${PORT_FORWARD_COMMAND}"
echo ""
echo "   Then open: http://localhost:${GATEWAY_PORT}"
echo ""
echo "   Retrieve the gateway password:"
echo "     ${PASSWORD_COMMAND}"
echo ""
echo "   Open a shell on the instance:"
echo "     ${SSM_COMMAND}"

# Output values for downstream blocks
echo "instance_id=${INSTANCE_ID}" >> "$GRUNTBOOK_OUTPUT"
echo "ssm_command=${SSM_COMMAND}" >> "$GRUNTBOOK_OUTPUT"
echo "ssm_port_forward_command=${PORT_FORWARD_COMMAND}" >> "$GRUNTBOOK_OUTPUT"
echo "ssm_password_command=${PASSWORD_COMMAND}" >> "$GRUNTBOOK_OUTPUT"
