#!/bin/bash

# Example check script that demonstrates SUCCESS exit code (0)
# This script simulates a successful validation check

set -e

echo "🔍 Starting validation..."
sleep 0.5

echo "✅ Step 1: Checking prerequisites..."
sleep 0.5

echo "✅ Step 2: Validating configuration..."
sleep 0.5

echo "✅ Step 3: Running tests..."
sleep 0.5

echo "🎉 All checks passed successfully!"

# Exit with code 0 for SUCCESS
exit 0

