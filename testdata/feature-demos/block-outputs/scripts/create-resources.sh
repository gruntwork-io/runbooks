#!/bin/bash
# Note: Block IDs use underscores in templates (hyphens aren't valid in Go template syntax)
# The block id="create-account" becomes .outputs.create_account in templates
echo "Creating resources in account {{ .outputs.create_account.account_id }}..."
echo "Region: {{ .outputs.create_account.region }}"
sleep 1

# Simulate resource creation
ROLE_ARN="arn:aws:iam::{{ .outputs.create_account.account_id }}:role/MyRole"

echo "Created IAM role: $ROLE_ARN"

# Output for downstream blocks
echo "role_arn=$ROLE_ARN" >> "$RUNBOOK_OUTPUT"
