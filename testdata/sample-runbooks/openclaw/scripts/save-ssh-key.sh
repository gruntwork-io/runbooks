#!/bin/bash
set -e

# Save the auto-generated SSH private key to the local machine.
#
# Environment variables:
#   - REPO_FILES: Path to the infra-live clone
#   - RUNBOOK_DRY_RUN: Set to "true" to print commands instead of executing them

DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

INSTANCE_NAME="{{ .inputs.InstanceName }}"
KEY_PATH="$HOME/.ssh/${INSTANCE_NAME}-key"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "🔑 Dry-run mode: Simulating SSH key save..."
    echo ""
    echo "[DRY-RUN] cd \$REPO_FILES"
    echo "[DRY-RUN] terragrunt output -raw private_key_openssh > ${KEY_PATH}"
    echo "[DRY-RUN] chmod 600 ${KEY_PATH}"
    echo ""
    echo "✅ Dry-run completed successfully!"
    exit 0
fi

cd "${REPO_FILES}/{{ .inputs.AccountName }}/{{ .inputs.ModuleName }}"

echo "🔑 Saving SSH private key to ${KEY_PATH}..."

terragrunt output -raw private_key_openssh > "${KEY_PATH}"
chmod 600 "${KEY_PATH}"

# Get the Elastic IP from outputs
ELASTIC_IP=$(terragrunt output -raw public_ip 2>/dev/null || echo "<elastic-ip>")

echo ""
echo "✅ SSH key saved to ${KEY_PATH}"
echo ""
echo "   Connect to the instance with:"
echo "     ssh -i ${KEY_PATH} ubuntu@${ELASTIC_IP}"

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
echo "ssh_command=ssh -i ${KEY_PATH} ubuntu@${ELASTIC_IP}" >> "$RUNBOOK_OUTPUT"
echo "elastic_ip=${ELASTIC_IP}" >> "$RUNBOOK_OUTPUT"
echo "key_path=${KEY_PATH}" >> "$RUNBOOK_OUTPUT"
echo "tailscale_ip=${TAILSCALE_IP}" >> "$RUNBOOK_OUTPUT"
