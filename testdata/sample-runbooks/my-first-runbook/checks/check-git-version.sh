#!/bin/bash

# Git Version Validation Script
# This script checks if the user has the expected version of git installed.
# The Check's env prop sets EXPECTED_VERSION from the GitVersion input.

echo "🔍 Checking git version..."
echo "📋 Expected version: $EXPECTED_VERSION"

# Get the installed git version (extract just the version number, e.g., "2.39.5")
INSTALLED_VERSION=$(git --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

if [ -z "$INSTALLED_VERSION" ]; then
    echo "❌ Git is not installed"
    exit 1
fi

echo "💻 Installed version: $INSTALLED_VERSION"

# Compare versions
if [ "$INSTALLED_VERSION" = "$EXPECTED_VERSION" ]; then
    echo "✅ You are running the exact expected git version!"
    exit 0
else
    echo "⚠️ Version mismatch: expected $EXPECTED_VERSION, but found $INSTALLED_VERSION"
    exit 1
fi

