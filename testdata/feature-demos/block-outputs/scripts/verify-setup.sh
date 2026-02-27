#!/bin/bash
# Note: Block IDs use underscores in templates (hyphens aren't valid in Go template syntax)
echo "Verifying setup..."
echo "Account: {{ .outputs.create_account.account_id }}"
echo "Region: {{ .outputs.create_account.region }}"
echo "Role: {{ .outputs.create_resources.role_arn }}"

# Validation logic
if [[ -n "{{ .outputs.create_account.account_id }}" ]]; then
  echo "✓ Account ID present"
else
  echo "✗ Account ID missing"
  exit 1
fi

if [[ -n "{{ .outputs.create_resources.role_arn }}" ]]; then
  echo "✓ Role ARN present"
else
  echo "✗ Role ARN missing"
  exit 1
fi

echo "All validations passed!"
exit 0
