#!/usr/bin/env bash
# The script view shows <redacted> in place of the token, but Runbooks runs
# this script with the real value. Never echo the token itself: the log isn't
# masked.
TOKEN="{{ .outputs.fetch_api_token.api_token }}"

echo "Calling the API as {{ .outputs.fetch_api_token.api_user }} with a ${#TOKEN}-character token"
echo "token_length=${#TOKEN}" >> "$RUNBOOK_OUTPUT"
