#!/bin/bash

# KMS Key Validation Script
# This script checks if your KMS key is properly configured

set -e

echo "🔍 Starting KMS key validation..."
echo "📍 Region: {{ .AwsRegion }}"
echo "🔑 Key ID: {{ .KMSKeyId }}"

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed"
    exit 1
fi

# Validate KMS key
echo "🔍 Checking if key exists..."
if aws kms describe-key --key-id "{{ .KMSKeyId }}" --region "{{ .AwsRegion }}" > /dev/null 2>&1; then
    echo "✅ KMS key exists and is accessible"
else
    echo "❌ KMS key not found or not accessible"
    exit 1
fi

echo "🎉 Validation completed successfully!"

