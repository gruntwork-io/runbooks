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
# The $GRUNTBOOK_OUTPUT file is set by the gruntbook server
echo "account_id=$ACCOUNT_ID" >> "$GRUNTBOOK_OUTPUT"
echo "region=$REGION" >> "$GRUNTBOOK_OUTPUT"