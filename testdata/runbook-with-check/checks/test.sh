#!/bin/bash

# KMS Key Validation Script
# This script checks if your KMS key is properly configured

set -e

echo "🔍 Starting KMS key validation..."

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed"
    exit 1
fi

# Check if key ID is provided
if [ -z "$KMS_KEY_ID" ]; then
    echo "❌ KMS_KEY_ID environment variable is not set"
    exit 1
fi

echo "🔑 Validating KMS key: $KMS_KEY_ID"

# Check if key exists and is accessible
if aws kms describe-key --key-id "$KMS_KEY_ID" > /dev/null 2>&1; then
    echo "✅ KMS key exists and is accessible"
else
    echo "❌ KMS key not found or not accessible"
    exit 1
fi

# Check key policy
echo "📋 Checking key policy..."
KEY_POLICY=$(aws kms get-key-policy --key-id "$KMS_KEY_ID" --policy-name default --query 'Policy' --output text)

if echo "$KEY_POLICY" | grep -q "arn:aws:iam::*:root"; then
    echo "✅ Key policy allows root access"
else
    echo "⚠️  Key policy may not allow root access"
fi

# Test encryption/decryption
echo "🔐 Testing encryption/decryption..."
TEST_DATA="test-data-$(date +%s)"
ENCRYPTED=$(aws kms encrypt --key-id "$KMS_KEY_ID" --plaintext "$TEST_DATA" --query 'CiphertextBlob' --output text)

if [ -n "$ENCRYPTED" ]; then
    echo "✅ Encryption successful"
    
    # Test decryption
    DECRYPTED=$(aws kms decrypt --ciphertext-blob "$ENCRYPTED" --query 'Plaintext' --output text | base64 -d)
    
    if [ "$DECRYPTED" = "$TEST_DATA" ]; then
        echo "✅ Decryption successful"
        echo "🎉 KMS key validation completed successfully!"
    else
        echo "❌ Decryption failed"
        exit 1
    fi
else
    echo "❌ Encryption failed"
    exit 1
fi