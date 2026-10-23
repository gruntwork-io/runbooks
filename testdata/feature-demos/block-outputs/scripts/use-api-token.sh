#!/usr/bin/env bash
# TOKEN and API_USER come from the block's env prop. The block lists TOKEN as
# <redacted>, but Runbooks runs this script with the real value. Never echo
# the token itself: the log isn't masked.
echo "Calling the API as $API_USER with a ${#TOKEN}-character token"
echo "token_length=${#TOKEN}" >> "$RUNBOOK_OUTPUT"
