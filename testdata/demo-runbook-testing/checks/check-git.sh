#!/bin/bash
# Check that git is installed

if ! command -v git &> /dev/null; then
    echo "ERROR: git is not installed"
    exit 1
fi

echo "Git version: $(git --version)"
echo "Git is installed and available"
