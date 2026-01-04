#!/bin/bash
# Verify AWS authentication by calling STS GetCallerIdentity

set -e

echo "Checking AWS authentication..."

if aws sts get-caller-identity > /dev/null 2>&1; then
    echo "✅ Successfully authenticated to AWS!"
    aws sts get-caller-identity --output yaml
    exit 0
else
    echo "❌ AWS authentication failed"
    echo "Please ensure you have valid AWS credentials configured."
    exit 1
fi

