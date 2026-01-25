#!/bin/bash

# Example check script that demonstrates FAILURE exit code (1)
# This script simulates a failed validation check

echo "🔍 Starting validation..."
sleep 0.5

echo "✅ Step 1: Checking prerequisites..."
sleep 0.5

echo "❌ Step 2: Configuration validation failed!"
echo "    ERROR: Required environment variable DATABASE_URL is not set"
echo "    ERROR: Missing required configuration file: config.json"
sleep 0.5

echo "💥 Validation failed - cannot proceed"
echo "Please fix the errors above and try again."

# Exit with code 1 for FAILURE
exit 1

