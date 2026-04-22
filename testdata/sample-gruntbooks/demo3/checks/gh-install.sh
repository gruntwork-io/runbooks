#!/bin/bash

# Check if Mise is installed
if ! command -v gh &> /dev/null; then
    echo "❌ gh is not installed"
    exit 1
fi

echo "✅ gh is installed"