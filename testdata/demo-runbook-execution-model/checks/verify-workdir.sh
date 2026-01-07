#!/bin/bash
# Verify that working directory change persisted

echo "Checking working directory..."
echo ""

current_dir=$(pwd)
echo "Current directory: $current_dir"

errors=0

# Check if we're in /tmp
if [ "$current_dir" != "/tmp" ] && [ "$current_dir" != "/private/tmp" ]; then
    echo "❌ Expected to be in /tmp, but we're in: $current_dir"
    errors=$((errors + 1))
else
    echo "✅ Correctly in /tmp (or /private/tmp on macOS)"
fi

# Check the marker variable
if [ "$DEMO_WORKDIR_CHANGED" != "true" ]; then
    echo "❌ DEMO_WORKDIR_CHANGED marker not found"
    errors=$((errors + 1))
else
    echo "✅ DEMO_WORKDIR_CHANGED=true (marker present)"
fi

echo ""

if [ $errors -gt 0 ]; then
    echo "Working directory change did not persist. Did you run Block 5?"
    exit 1
fi

echo "Working directory change persisted correctly!"
echo "The persistent environment tracks directory changes."

