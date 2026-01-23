#!/bin/bash
set -e

# Run terragrunt apply for the Lambda function
# Template variables from lambda-config and repo-config:
#   - GithubOrgName -> GitHub organization name
#   - GithubRepoName -> GitHub repository name
#   - FunctionName -> Lambda function name
#   - Environment -> Target environment
#   - AwsRegion -> AWS region

GITHUB_ORG="{{ .GithubOrgName }}"
REPO_NAME="{{ .GithubRepoName }}"
FUNCTION_NAME="{{ .FunctionName }}"
ENVIRONMENT="{{ .Environment }}"
AWS_REGION="{{ .AwsRegion }}"

BRANCH_NAME="add-lambda-${FUNCTION_NAME}-${ENVIRONMENT}"
TARGET_PATH="${ENVIRONMENT}/${AWS_REGION}/${FUNCTION_NAME}"

# First, check if the user is authenticated to AWS
echo "🔐 Checking AWS authentication..."
if ! aws sts get-caller-identity &> /dev/null; then
  echo "❌ Not authenticated to AWS"
  echo ""
  echo "   You need valid AWS credentials to run terragrunt apply."
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

# Clone the repository
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "📦 Cloning repository: ${GITHUB_ORG}/${REPO_NAME}..."
cd "$TEMP_DIR"
gh repo clone "${GITHUB_ORG}/${REPO_NAME}" repo
cd repo

echo "🌿 Checking out branch: ${BRANCH_NAME}..."
git fetch origin "$BRANCH_NAME"
git checkout "$BRANCH_NAME"
echo ""

# Run terragrunt apply
echo "🚀 Running terragrunt apply for: $FUNCTION_NAME-$ENVIRONMENT in $AWS_REGION..."
echo "   Path: ${TARGET_PATH}"
echo ""

cd "${TARGET_PATH}"

if terragrunt run --backend-bootstrap --non-interactive -- apply -auto-approve; then
  echo ""
  echo "✅ Terragrunt apply completed successfully!"
  echo ""
  echo "   Your Lambda function has been deployed to AWS."
  exit 0
else
  echo ""
  echo "❌ Terragrunt apply failed"
  echo ""
  echo "   Possible causes:"
  echo "   - Missing or invalid configuration"
  echo "   - Insufficient IAM permissions"
  echo "   - Resource conflicts or state issues"
  exit 1
fi
