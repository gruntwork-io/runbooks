#!/bin/bash
set -e

# Print the SSM connect command and instance details after deployment.
#
# Environment variables:
#   - REPO_FILES: Path to the infra-live clone
#   - RUNBOOK_DRY_RUN: Set to "true" to print commands instead of executing them

DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

INSTANCE_NAME="{{ .inputs.InstanceName }}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "🔑 Dry-run mode: Simulating SSM connection info..."
    echo ""
    echo "[DRY-RUN] cd \$REPO_FILES"
    echo "[DRY-RUN] terragrunt output -raw instance_id"
    echo "[DRY-RUN] terragrunt output -raw ssm_connect_command"
    echo ""
    echo "✅ Dry-run completed successfully!"
    exit 0
fi

cd "${REPO_FILES}/{{ .inputs.AccountName }}/{{ .inputs.AwsRegion }}/{{ .inputs.ModuleName }}"

INSTANCE_ID=$(terragrunt output -raw instance_id 2>/dev/null || echo "<instance-id>")
SSM_COMMAND=$(terragrunt output -raw ssm_connect_command 2>/dev/null || echo "aws ssm start-session --target <instance-id>")

echo ""
echo "✅ OpenClaw instance deployed: ${INSTANCE_ID}"
echo ""
echo "   Connect to the instance with SSM Session Manager:"
echo "     ${SSM_COMMAND}"
echo ""
echo "   Monitor cloud-init progress:"
echo "     ${SSM_COMMAND} then run: tail -f /var/log/cloud-init-output.log"

# Try to resolve the Tailscale IP for the instance
TAILSCALE_IP=""
if command -v tailscale &> /dev/null; then
    TAILSCALE_IP=$(tailscale status 2>/dev/null | grep -i "${INSTANCE_NAME}" | awk '{print $1}' || true)
fi

if [[ -n "$TAILSCALE_IP" ]]; then
    echo ""
    echo "   Tailscale IP: ${TAILSCALE_IP}"
fi

# Output values for downstream blocks
echo "instance_id=${INSTANCE_ID}" >> "$RUNBOOK_OUTPUT"
echo "ssm_command=${SSM_COMMAND}" >> "$RUNBOOK_OUTPUT"
echo "tailscale_ip=${TAILSCALE_IP}" >> "$RUNBOOK_OUTPUT"
