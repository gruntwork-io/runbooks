#!/bin/bash
set -e

# Test Lambda function by invoking it
# Template variables: FunctionName, Environment, AwsRegion

FUNCTION_NAME="{{ .FunctionName }}-{{ .Environment }}"
AWS_REGION="{{ .AwsRegion }}"

# First, check if the user is authenticated to AWS
echo "🔐 Checking AWS authentication..."
if ! aws sts get-caller-identity &> /dev/null; then
  echo "❌ Not authenticated to AWS"
  echo ""
  echo "   You need valid AWS credentials to invoke the Lambda function."
  echo ""
  
  # Check if granted is installed and recommend it
  if command -v assume &> /dev/null; then
    echo "   Use Granted to assume a role:"
    echo "     assume <profile-name>"
    echo ""
    echo "   Example:"
    echo "     assume sandbox"
    echo ""
    echo "   List available profiles:"
    echo "     assume --list"
  else
    echo "   Option 1: Install Granted (recommended)"
    echo "     brew tap common-fate/granted && brew install granted"
    echo "     assume <profile-name>"
    echo ""
    echo "   Option 2: Use AWS CLI directly"
    echo "     aws sso login --profile <profile-name>"
    echo "     export AWS_PROFILE=<profile-name>"
  fi
  exit 1
fi

# Get the identity info
IDENTITY=$(aws sts get-caller-identity --output json 2>/dev/null)
ACCOUNT=$(echo "$IDENTITY" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
ARN=$(echo "$IDENTITY" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4)

echo "✅ Authenticated to AWS"
echo "   Account: $ACCOUNT"
echo "   Identity: $ARN"
echo ""

# Invoke the Lambda function
echo "🚀 Invoking Lambda function: $FUNCTION_NAME in $AWS_REGION..."

RESPONSE_FILE=$(mktemp)
trap "rm -f $RESPONSE_FILE" EXIT

if aws lambda invoke \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION" \
  "$RESPONSE_FILE" > /dev/null 2>&1; then
  
  echo "✅ Lambda function invoked successfully!"
  echo ""
  echo "📄 Response:"
  cat "$RESPONSE_FILE"
  echo ""
  exit 0
else
  echo "❌ Failed to invoke Lambda function: $FUNCTION_NAME"
  echo ""
  echo "   Possible causes:"
  echo "   - Function doesn't exist yet (deploy it first)"
  echo "   - Insufficient IAM permissions"
  echo "   - Function name or region is incorrect"
  exit 1
fi

