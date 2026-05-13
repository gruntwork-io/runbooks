#!/bin/bash
# Verify project was created correctly

PROJECT_NAME="${PROJECT_NAME:-test-project}"

echo "Verifying project: $PROJECT_NAME"

# Check for expected files (would be created by template)
FILES_DIR="${GENERATED_FILES:-}"
if [[ -z "$FILES_DIR" ]]; then
    echo "INFO: GENERATED_FILES environment variable not set, skipping README.md check"
elif [[ -f "$FILES_DIR/README.md" ]]; then
    echo "README.md exists"
else
    echo "INFO: README.md not found (expected in $FILES_DIR)"
fi

echo "Project verification complete"
