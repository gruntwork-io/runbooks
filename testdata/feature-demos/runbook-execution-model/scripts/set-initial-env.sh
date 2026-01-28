#!/bin/bash
# Set initial environment variables for the demo

echo "Setting initial environment variables..."

export DEMO_VAR="hello-from-block-1000"
export DEMO_COUNT=1
export DEMO_PROJECT="runbooks-persistent-env-demo"

echo ""
echo "Environment variables set:"
echo "  DEMO_VAR=$DEMO_VAR"
echo "  DEMO_COUNT=$DEMO_COUNT"
echo "  DEMO_PROJECT=$DEMO_PROJECT"
echo ""
echo "These variables will persist to subsequent blocks!"

