#!/usr/bin/env bash
# Verify that the variables Block 1 wrote to RUNBOOK_ENV are set

echo "Checking for environment variables from Block 1..."
echo ""

errors=0

if [ -z "$DEMO_VAR" ]; then
    echo "❌ DEMO_VAR is not set!"
    errors=$((errors + 1))
else
    echo "✅ DEMO_VAR=$DEMO_VAR"
fi

if [ -z "$DEMO_COUNT" ]; then
    echo "❌ DEMO_COUNT is not set!"
    errors=$((errors + 1))
else
    echo "✅ DEMO_COUNT=$DEMO_COUNT"
fi

if [ -z "$DEMO_PROJECT" ]; then
    echo "❌ DEMO_PROJECT is not set!"
    errors=$((errors + 1))
else
    echo "✅ DEMO_PROJECT=$DEMO_PROJECT"
fi

if [ -n "${DEMO_EXPORT_ONLY:-}" ]; then
    echo "❌ DEMO_EXPORT_ONLY is set, but an export should stay in its own script"
    errors=$((errors + 1))
else
    echo "✅ DEMO_EXPORT_ONLY is not set (Block 1 only exported it)"
fi

echo ""

if [ $errors -gt 0 ]; then
    echo "Some environment variables are missing. Did you run Block 1 first?"
    exit 1
fi

echo "All environment variables Block 1 wrote to \$RUNBOOK_ENV are present!"

