#!/bin/bash
echo "Creating AWS account..."
sleep 1

# Simulate account creation
ACCOUNT_ID="123456789012"
REGION="us-west-2"

echo "Account created successfully!"
echo "Account ID: $ACCOUNT_ID"
echo "Region: $REGION"

# Output values for downstream blocks
# The $RUNBOOK_OUTPUT file is set by the runbook server
echo "account_id=$ACCOUNT_ID" >> "$RUNBOOK_OUTPUT"
echo "region=$REGION" >> "$RUNBOOK_OUTPUT"