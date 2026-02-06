#!/bin/bash
# Example script that assumes a role and outputs credentials
# The target account ID and role name can be customized via inputs

TARGET_ACCOUNT_ID="{{ .TargetAccountId }}"
ROLE_NAME="{{ .RoleName }}"
ROLE_ARN="arn:aws:iam::${TARGET_ACCOUNT_ID}:role/${ROLE_NAME}"
SESSION_NAME="runbook-session"

echo "Attempting to assume role: $ROLE_ARN"

# Assume the role (capture both stdout and stderr)
CREDS=$(aws sts assume-role \
  --role-arn "$ROLE_ARN" \
  --role-session-name "$SESSION_NAME" \
  --output json 2>&1)

if [ $? -eq 0 ]; then
  # Output credentials in the format expected by AwsAuth
  echo "AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r '.Credentials.AccessKeyId')" >> "$RUNBOOK_OUTPUT"
  echo "AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r '.Credentials.SecretAccessKey')" >> "$RUNBOOK_OUTPUT"
  echo "AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r '.Credentials.SessionToken')" >> "$RUNBOOK_OUTPUT"
  echo "Successfully assumed role: $ROLE_ARN"
else
  echo "Failed to assume role: $ROLE_ARN"
  echo "Error: $CREDS"
  exit 1
fi
