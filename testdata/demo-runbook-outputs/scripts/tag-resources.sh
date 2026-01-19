#!/bin/bash
# This script demonstrates using BOTH standard inputs and block outputs.
# See the syntax comparison table in the runbook for details.

echo "Tagging resources..."
echo ""
echo "=== Values from Inputs block (standard variables) ==="
echo "Environment: {{ .environment }}"
echo "Owner: {{ .owner }}"
echo ""
echo "=== Values from upstream block outputs ==="
echo "Account ID: {{ ._blocks.create_account.outputs.account_id }}"
echo "Region: {{ ._blocks.create_account.outputs.region }}"
echo "Role ARN: {{ ._blocks.create_resources.outputs.role_arn }}"
echo ""

# Use both types together
echo "Applying tags to role in account {{ ._blocks.create_account.outputs.account_id }}..."
sleep 1

TAG_SUMMARY="env={{ .environment }},owner={{ .owner }},account={{ ._blocks.create_account.outputs.account_id }}"
echo "Tags applied: $TAG_SUMMARY"
echo ""
echo "Successfully tagged resources for {{ .owner }} in the {{ .environment }} environment!"

# Output combined values for potential downstream use
echo "tag_summary=$TAG_SUMMARY" >> "$RUNBOOK_OUTPUT"
