#!/bin/bash

# Check if the GitHub CLI is installed
if ! command -v gh &> /dev/null; then
    echo "gh is not installed"
    exit 1
fi

GH_VERSION=$(gh --version | head -1)
echo "GitHub CLI is installed: ${GH_VERSION}"

# Check if authenticated
if gh auth status &> /dev/null; then
    echo "Authenticated to GitHub"
else
    echo "Not authenticated to GitHub. Run: gh auth login"
    exit 1
fi
