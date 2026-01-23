#!/bin/bash
# Verify project was created correctly

if [[ -z "$PROJECT_NAME" ]]; then
    echo "ERROR: PROJECT_NAME environment variable not set"
    exit 1
fi

echo "Verifying project: $PROJECT_NAME"

# Check for expected files (would be created by template)
if [[ -f "$RUNBOOK_FILES/README.md" ]]; then
    echo "README.md exists"
else
    echo "INFO: README.md not found (expected in $RUNBOOK_FILES)"
fi

echo "Project verification complete"
