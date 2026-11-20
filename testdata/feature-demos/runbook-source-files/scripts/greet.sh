#!/bin/bash
set -euo pipefail

source "$RUNBOOK_SOURCE_FILES/scripts/lib.sh"

echo "message=$(greeting)" >> "$RUNBOOK_OUTPUT"
