#!/bin/bash
# ACCOUNT_ID, REGION and ROLE_ARN are outputs of earlier blocks, which the
# block's env prop passes in
echo "Verifying setup..."
echo "Account: $ACCOUNT_ID"
echo "Region: $REGION"
echo "Role: $ROLE_ARN"

# Validation logic
if [[ -n "$ACCOUNT_ID" ]]; then
  echo "✓ Account ID present"
else
  echo "✗ Account ID missing"
  exit 1
fi

if [[ -n "$ROLE_ARN" ]]; then
  echo "✓ Role ARN present"
else
  echo "✗ Role ARN missing"
  exit 1
fi

echo "All validations passed!"
exit 0
