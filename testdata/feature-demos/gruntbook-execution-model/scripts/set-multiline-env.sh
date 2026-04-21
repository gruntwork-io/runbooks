#!/bin/bash
# Demonstrate setting environment variables with multiline values
# This tests that embedded newlines are correctly preserved across sessions

# Simulate an RSA-style key with multiple lines
export MULTILINE_KEY="-----BEGIN EXAMPLE KEY-----
line1-of-key-content
line2-of-key-content
line3-of-key-content
-----END EXAMPLE KEY-----"

# JSON with newlines
export JSON_CONFIG='{
  "database": "postgres",
  "host": "localhost",
  "settings": {
    "timeout": 30
  }
}'

# Simple multiline string
export MULTILINE_SIMPLE="first line
second line
third line"

echo "Set multiline environment variables:"
echo ""
echo "MULTILINE_KEY (5 lines):"
echo "$MULTILINE_KEY"
echo ""
echo "JSON_CONFIG:"
echo "$JSON_CONFIG"
echo ""
echo "MULTILINE_SIMPLE:"
echo "$MULTILINE_SIMPLE"
