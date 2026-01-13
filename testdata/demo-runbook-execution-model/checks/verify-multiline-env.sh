#!/bin/bash
# Verify that multiline environment variables persisted correctly
# This is the key test - if newlines are corrupted, this check will fail

errors=0

echo "Checking MULTILINE_KEY..."
if [[ -z "$MULTILINE_KEY" ]]; then
    echo "❌ MULTILINE_KEY is not set"
    errors=$((errors + 1))
else
    # Count the number of lines
    line_count=$(echo "$MULTILINE_KEY" | wc -l | tr -d ' ')
    if [[ "$line_count" -eq 5 ]]; then
        echo "✅ MULTILINE_KEY has correct line count: $line_count"
    else
        echo "❌ MULTILINE_KEY has wrong line count: $line_count (expected 5)"
        echo "   Value: $MULTILINE_KEY"
        errors=$((errors + 1))
    fi
    
    # Check it contains the markers
    if [[ "$MULTILINE_KEY" == *"BEGIN EXAMPLE KEY"* ]] && [[ "$MULTILINE_KEY" == *"END EXAMPLE KEY"* ]]; then
        echo "✅ MULTILINE_KEY contains correct markers"
    else
        echo "❌ MULTILINE_KEY is missing expected markers"
        errors=$((errors + 1))
    fi
fi

echo ""
echo "Checking JSON_CONFIG..."
if [[ -z "$JSON_CONFIG" ]]; then
    echo "❌ JSON_CONFIG is not set"
    errors=$((errors + 1))
else
    # Check it contains expected JSON structure
    if [[ "$JSON_CONFIG" == *'"database"'* ]] && [[ "$JSON_CONFIG" == *'"settings"'* ]]; then
        echo "✅ JSON_CONFIG contains expected structure"
    else
        echo "❌ JSON_CONFIG is missing expected JSON keys"
        echo "   Value: $JSON_CONFIG"
        errors=$((errors + 1))
    fi
    
    # Count lines - should be multiline
    line_count=$(echo "$JSON_CONFIG" | wc -l | tr -d ' ')
    if [[ "$line_count" -ge 5 ]]; then
        echo "✅ JSON_CONFIG preserved as multiline: $line_count lines"
    else
        echo "❌ JSON_CONFIG lost newlines: only $line_count lines (expected 6+)"
        errors=$((errors + 1))
    fi
fi

echo ""
echo "Checking MULTILINE_SIMPLE..."
if [[ -z "$MULTILINE_SIMPLE" ]]; then
    echo "❌ MULTILINE_SIMPLE is not set"
    errors=$((errors + 1))
else
    line_count=$(echo "$MULTILINE_SIMPLE" | wc -l | tr -d ' ')
    if [[ "$line_count" -eq 3 ]]; then
        echo "✅ MULTILINE_SIMPLE has correct line count: $line_count"
    else
        echo "❌ MULTILINE_SIMPLE has wrong line count: $line_count (expected 3)"
        errors=$((errors + 1))
    fi
fi

echo ""
if [[ $errors -eq 0 ]]; then
    echo "✅ All multiline environment variables preserved correctly!"
    exit 0
else
    echo "❌ $errors error(s) found - multiline values may have been corrupted"
    exit 1
fi
