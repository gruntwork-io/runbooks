#!/bin/bash
# Note: Block IDs use underscores in templates (hyphens aren't valid in Go template syntax)
echo "Verifying setup..."
echo "Account: {{ ._blocks.create_account.outputs.account_id }}"
echo "Region: {{ ._blocks.create_account.outputs.region }}"
echo "Role: {{ ._blocks.create_resources.outputs.role_arn }}"

# Validation logic
if [[ -n "{{ ._blocks.create_account.outputs.account_id }}" ]]; then
  echo "✓ Account ID present"
else
  echo "✗ Account ID missing"
  exit 1
fi

if [[ -n "{{ ._blocks.create_resources.outputs.role_arn }}" ]]; then
  echo "✓ Role ARN present"
else
  echo "✗ Role ARN missing"
  exit 1
fi

echo "All validations passed!"
exit 0
