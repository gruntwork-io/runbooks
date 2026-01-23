#!/bin/bash

# Example check script that demonstrates WARNING exit code (2)
# This script simulates a check that passes but with warnings

echo "🔍 Starting validation..."
sleep 0.5

echo "✅ Step 1: Checking prerequisites..."
sleep 0.5

echo "⚠️  Step 2: Configuration is valid but not optimal..."
echo "    - Recommendation: Consider enabling encryption at rest"
echo "    - Recommendation: Enable versioning for better recovery"
sleep 0.5

echo "✅ Step 3: Running basic tests..."
sleep 0.5

echo "⚠️  Validation completed with warnings"
echo "The system will work, but we recommend addressing the warnings above."

# Exit with code 2 for WARNING
exit 2

