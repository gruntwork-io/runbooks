#!/bin/bash
# This script demonstrates using BOTH standard inputs and block outputs.
# The block's env prop passes them in. See the syntax comparison table in the
# runbook for details.

echo "Tagging resources..."
echo ""
echo "=== Values from Inputs block (standard variables) ==="
echo "Environment: $ENVIRONMENT"
echo "Owner: $OWNER"
echo ""
echo "=== Values from upstream block outputs ==="
echo "Account ID: $ACCOUNT_ID"
echo "Region: $REGION"
echo "Role ARN: $ROLE_ARN"
echo ""

# Use both types together
echo "Applying tags to role in account $ACCOUNT_ID..."
sleep 1

TAG_SUMMARY="env=$ENVIRONMENT,owner=$OWNER,account=$ACCOUNT_ID"
echo "Tags applied: $TAG_SUMMARY"
echo ""
echo "Successfully tagged resources for $OWNER in the $ENVIRONMENT environment!"

# Output combined values for potential downstream use
echo "tag_summary=$TAG_SUMMARY" >> "$RUNBOOK_OUTPUT"
