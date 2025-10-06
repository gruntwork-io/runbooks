#!/bin/bash
# Check if AWS CLI is installed and configured

set -e

if ! command -v aws &> /dev/null; then
    echo "✗ AWS CLI is not installed"
    echo "Please install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

echo "✓ AWS CLI is installed: $(aws --version)"

# Check if AWS credentials are configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "✗ AWS credentials are not configured"
    echo "Please run 'aws configure' to set up your credentials"
    exit 1
fi

echo "✓ AWS credentials are configured"
echo "  Account: $(aws sts get-caller-identity --query Account --output text)"
echo "  User/Role: $(aws sts get-caller-identity --query Arn --output text)"

exit 0

