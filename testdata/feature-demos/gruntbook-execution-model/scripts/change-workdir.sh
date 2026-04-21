#!/bin/bash
# Change working directory to demonstrate persistence

echo "Current working directory:"
pwd
echo ""

echo "Changing to /tmp..."
cd /tmp

echo "New working directory:"
pwd
echo ""

# Export a marker to prove we changed directories
export DEMO_WORKDIR_CHANGED="true"
export DEMO_EXPECTED_DIR="/tmp"

echo "Working directory changed!"
echo "This will persist to subsequent blocks."

