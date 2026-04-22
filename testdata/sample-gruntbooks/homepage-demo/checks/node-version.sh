#!/bin/bash
# Check that Node.js is installed
node_version=$(node --version 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "Node.js is not installed"
  exit 1
fi
echo "Node.js $node_version is installed"
