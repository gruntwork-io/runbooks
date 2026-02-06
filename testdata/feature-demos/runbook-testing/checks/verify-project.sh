#!/bin/bash
# Verify project was created correctly

if [[ -z "$PROJECT_NAME" ]]; then
    echo "ERROR: PROJECT_NAME environment variable not set"
    exit 1
fi

echo "Verifying project: $PROJECT_NAME"

# Check for expected files (would be created by template)
# Support both new and legacy env var names
FILES_DIR="${GENERATED_FILES:-${RUNBOOK_FILES:-}}"
if [[ -z "$FILES_DIR" ]]; then
    echo "INFO: GENERATED_FILES environment variable not set, skipping README.md check"
elif [[ -f "$FILES_DIR/README.md" ]]; then
    echo "README.md exists"
else
    echo "INFO: README.md not found (expected in $FILES_DIR)"
fi

echo "Project verification complete"
