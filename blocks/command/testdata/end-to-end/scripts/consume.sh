#!/usr/bin/env bash
set -euo pipefail
test "$FROM_SETUP" = eu-west-2
test "{{ .outputs.setup.region }}" = us-east-1
echo "seen=$FROM_SETUP/{{ .outputs.setup.region }}" >> "$RUNBOOK_OUTPUT"
