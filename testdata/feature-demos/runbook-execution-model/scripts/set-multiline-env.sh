#!/usr/bin/env bash
# Set variables whose values have newlines in them. Each one is written as
# NAME<<DELIMITER, then the value's lines, then the delimiter on a line of its own.

cat >> "$RUNBOOK_ENV" <<'ENVFILE'
MULTILINE_KEY<<END_OF_VALUE
-----BEGIN EXAMPLE KEY-----
line1-of-key-content
line2-of-key-content
line3-of-key-content
-----END EXAMPLE KEY-----
END_OF_VALUE
JSON_CONFIG<<END_OF_VALUE
{
  "database": "postgres",
  "host": "localhost",
  "settings": {
    "timeout": 30
  }
}
END_OF_VALUE
MULTILINE_SIMPLE<<END_OF_VALUE
first line
second line
third line
END_OF_VALUE
ENVFILE

echo "Wrote MULTILINE_KEY, JSON_CONFIG and MULTILINE_SIMPLE to \$RUNBOOK_ENV."
