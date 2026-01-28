#!/bin/bash

# Check if Mise is installed
if ! command -v mise &> /dev/null; then
    echo "❌ Mise is not installed"
    exit 1
fi

echo "✅ Mise is installed"