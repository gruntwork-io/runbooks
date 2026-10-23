#!/bin/bash
# ACCOUNT_ID and REGION are create-account's outputs, which the block's env
# prop passes in
echo "Creating resources in account $ACCOUNT_ID..."
echo "Region: $REGION"
sleep 1

# Simulate resource creation
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/MyRole"

echo "Created IAM role: $ROLE_ARN"

# Output for downstream blocks
echo "role_arn=$ROLE_ARN" >> "$RUNBOOK_OUTPUT"
