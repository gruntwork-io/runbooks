#!/bin/bash
# Create project and set outputs

set -e
set -o pipefail

# Validate RUNBOOK_OUTPUT is set and writable
if [[ -z "$RUNBOOK_OUTPUT" ]]; then
    echo "Error: RUNBOOK_OUTPUT is not set. Cannot write outputs." >&2
    exit 1
fi

if ! touch "$RUNBOOK_OUTPUT" 2>/dev/null; then
    echo "Error: RUNBOOK_OUTPUT ('$RUNBOOK_OUTPUT') is not writable." >&2
    exit 1
fi

# Generate a project ID (pipefail ensures failure if shasum is missing)
PROJECT_ID=$(date +%s | shasum | head -c 12)

if [[ -z "$PROJECT_ID" ]]; then
    echo "Error: Failed to generate PROJECT_ID. RUNBOOK_OUTPUT='$RUNBOOK_OUTPUT'" >&2
    exit 1
fi

echo "Creating project with ID: $PROJECT_ID"

# Export project name to environment for other blocks
export PROJECT_NAME="${PROJECT_NAME:-test-project}"

# Set outputs for other blocks to use
echo "project_id=$PROJECT_ID" >> "$RUNBOOK_OUTPUT"
echo "status=created" >> "$RUNBOOK_OUTPUT"

echo "Project created successfully!"
echo "Project ID: $PROJECT_ID"
