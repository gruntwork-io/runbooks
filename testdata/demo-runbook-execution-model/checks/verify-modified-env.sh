#!/bin/bash
# Verify that modifications from Block 3 persisted

echo "Checking for modified environment variables..."
echo ""

errors=0

# Check DEMO_COUNT was incremented
if [ "$DEMO_COUNT" != "2" ]; then
    echo "❌ DEMO_COUNT should be 2, but is: $DEMO_COUNT"
    errors=$((errors + 1))
else
    echo "✅ DEMO_COUNT=2 (correctly incremented)"
fi

# Check DEMO_MODIFIED exists
if [ -z "$DEMO_MODIFIED" ]; then
    echo "❌ DEMO_MODIFIED is not set!"
    errors=$((errors + 1))
else
    echo "✅ DEMO_MODIFIED=$DEMO_MODIFIED"
fi

# Check DEMO_VAR was updated
if [ "$DEMO_VAR" != "updated-in-block-3" ]; then
    echo "❌ DEMO_VAR should be 'updated-in-block-3', but is: $DEMO_VAR"
    errors=$((errors + 1))
else
    echo "✅ DEMO_VAR=updated-in-block-3 (correctly updated)"
fi

echo ""

if [ $errors -gt 0 ]; then
    echo "Some modifications did not persist. Did you run Block 3?"
    exit 1
fi

echo "All modifications from Block 3 are present!"
echo "Environment changes correctly propagate between blocks."

