#!/bin/bash

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Node.js is not installed"
    exit 1
fi

NODE_VERSION=$(node --version)
echo "Node.js is installed: ${NODE_VERSION}"

# Check if npx is available
if ! command -v npx &> /dev/null; then
    echo "npx is not available"
    exit 1
fi

echo "npx is available"
