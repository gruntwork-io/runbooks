#!/bin/bash
# Note: Block IDs use underscores in templates (hyphens aren't valid in Go template syntax)
# The block id="create-account" becomes ._blocks.create_account in templates
echo "Creating resources in account {{ ._blocks.create_account.outputs.account_id }}..."
echo "Region: {{ ._blocks.create_account.outputs.region }}"
sleep 1

# Simulate resource creation
ROLE_ARN="arn:aws:iam::{{ ._blocks.create_account.outputs.account_id }}:role/MyRole"

echo "Created IAM role: $ROLE_ARN"

# Output for downstream blocks
echo "role_arn=$ROLE_ARN" >> "$RUNBOOK_OUTPUT"
