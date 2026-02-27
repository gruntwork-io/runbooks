#!/bin/bash
# This script demonstrates using BOTH standard inputs and block outputs.
# See the syntax comparison table in the runbook for details.

echo "Tagging resources..."
echo ""
echo "=== Values from Inputs block (standard variables) ==="
echo "Environment: {{ .inputs.environment }}"
echo "Owner: {{ .inputs.owner }}"
echo ""
echo "=== Values from upstream block outputs ==="
echo "Account ID: {{ .outputs.create_account.account_id }}"
echo "Region: {{ .outputs.create_account.region }}"
echo "Role ARN: {{ .outputs.create_resources.role_arn }}"
echo ""

# Use both types together
echo "Applying tags to role in account {{ .outputs.create_account.account_id }}..."
sleep 1

TAG_SUMMARY="env={{ .inputs.environment }},owner={{ .inputs.owner }},account={{ .outputs.create_account.account_id }}"
echo "Tags applied: $TAG_SUMMARY"
echo ""
echo "Successfully tagged resources for {{ .inputs.owner }} in the {{ .inputs.environment }} environment!"

# Output combined values for potential downstream use
echo "tag_summary=$TAG_SUMMARY" >> "$RUNBOOK_OUTPUT"
