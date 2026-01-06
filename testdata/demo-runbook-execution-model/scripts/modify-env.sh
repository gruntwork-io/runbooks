#!/bin/bash
# Modify environment variables to demonstrate propagation

echo "Modifying environment variables..."
echo ""

# Show current values
echo "Current values:"
echo "  DEMO_COUNT=$DEMO_COUNT"
echo ""

# Increment DEMO_COUNT
export DEMO_COUNT=$((DEMO_COUNT + 1))

# Add a new variable
export DEMO_MODIFIED="modified-in-block-3"

# Update DEMO_VAR
export DEMO_VAR="updated-in-block-3"

echo "New values:"
echo "  DEMO_VAR=$DEMO_VAR (updated)"
echo "  DEMO_COUNT=$DEMO_COUNT (incremented)"
echo "  DEMO_MODIFIED=$DEMO_MODIFIED (new)"
echo ""
echo "These modifications will persist to subsequent blocks!"

