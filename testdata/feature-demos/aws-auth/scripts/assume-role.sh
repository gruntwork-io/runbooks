#!/usr/bin/env bash
# Example script that assumes a role and outputs credentials
# TARGET_ACCOUNT_ID and ROLE_NAME come from the block's env prop, set from
# its inputs

ROLE_ARN="arn:aws:iam::${TARGET_ACCOUNT_ID}:role/${ROLE_NAME}"
SESSION_NAME="runbook-session"

echo "Attempting to assume role: $ROLE_ARN"

# Assume the role (capture both stdout and stderr)
CREDS=$(aws sts assume-role \
  --role-arn "$ROLE_ARN" \
  --role-session-name "$SESSION_NAME" \
  --output json 2>&1)

if [ $? -eq 0 ]; then
  # Output credentials in the format expected by AwsAuth. The sensitive: prefix
  # masks the secrets in View Outputs; AwsAuth still reads them by their plain names.
  echo "AWS_ACCESS_KEY_ID=$(jq -r '.Credentials.AccessKeyId' <<< "$CREDS")" >> "$RUNBOOK_OUTPUT"
  echo "sensitive:AWS_SECRET_ACCESS_KEY=$(jq -r '.Credentials.SecretAccessKey' <<< "$CREDS")" >> "$RUNBOOK_OUTPUT"
  echo "sensitive:AWS_SESSION_TOKEN=$(jq -r '.Credentials.SessionToken' <<< "$CREDS")" >> "$RUNBOOK_OUTPUT"
  echo "Successfully assumed role: $ROLE_ARN"
else
  echo "Failed to assume role: $ROLE_ARN"
  echo "Error: $CREDS"
  exit 1
fi
