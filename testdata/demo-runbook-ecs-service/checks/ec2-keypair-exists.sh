#!/bin/bash
# Check if the specified EC2 key pair exists in the AWS region

set -e

# Get parameters from environment variables
AWS_REGION="${AWS_REGION:-us-east-1}"
KEY_PAIR_NAME="${KEY_PAIR_NAME:-}"

if [ -z "$KEY_PAIR_NAME" ]; then
    echo "✗ KEY_PAIR_NAME environment variable is not set"
    echo "Please provide the name of your EC2 key pair"
    exit 1
fi

# Check if the key pair exists
if aws ec2 describe-key-pairs --key-names "$KEY_PAIR_NAME" --region "$AWS_REGION" &> /dev/null; then
    echo "✓ EC2 key pair '$KEY_PAIR_NAME' exists in region $AWS_REGION"
    exit 0
else
    echo "✗ EC2 key pair '$KEY_PAIR_NAME' does not exist in region $AWS_REGION"
    echo "Please create a key pair or provide the name of an existing one"
    echo "You can create one with: aws ec2 create-key-pair --key-name $KEY_PAIR_NAME --region $AWS_REGION"
    exit 1
fi

