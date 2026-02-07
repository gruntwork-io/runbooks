#!/bin/bash
# Modify a file in the cloned repository to demonstrate the Changed tab.
# Uses $WORKTREE_FILES which points to the active git worktree (set by GitClone).

set -euo pipefail

REPO_DIR="${WORKTREE_FILES:-./infra-live}"

if [ ! -d "$REPO_DIR" ]; then
    echo "Error: Repository not found at $REPO_DIR."
    echo "Please run the 'Clone Infrastructure Live' step first."
    exit 1
fi

if [ ! -f "$REPO_DIR/root.hcl" ]; then
    echo "Error: root.hcl not found in $REPO_DIR."
    exit 1
fi

echo "Updating root.hcl with custom state bucket prefix..."
echo ""

cat >> "$REPO_DIR/root.hcl" << 'EOF'

# -------------------------------------------------------
# Custom configuration added by Runbooks
# -------------------------------------------------------

locals {
  custom_bucket_prefix = "my-company"
}
EOF

echo "Appended custom locals block to root.hcl"
echo ""

# Delete a file to demonstrate deleted file tracking in the Changed tab
echo "Removing CODEOWNERS (no longer needed)..."
rm -f "$REPO_DIR/CODEOWNERS"
echo "Deleted CODEOWNERS"
echo ""

echo "Check the Changed tab to review the diff."
