#!/bin/bash
set -euo pipefail

source ./scripts/lib.sh

echo "message=$(greeting)" >> "$RUNBOOK_OUTPUT"
