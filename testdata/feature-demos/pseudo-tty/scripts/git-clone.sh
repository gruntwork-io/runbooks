#!/bin/bash
set -e

REPO_URL="${1:-https://github.com/gruntwork-io/runbooks.git}"
CLONE_DIR="${2:-runbooks-pty-demo}"
CLONE_PATH="/tmp/$CLONE_DIR"

# Clean up any existing clone
rm -rf "$CLONE_PATH"

echo "=== Cloning repository ==="
echo "URL: $REPO_URL"
echo "Path: $CLONE_PATH"
echo ""

# Clone the repository (should show progress with PTY support)
git clone "$REPO_URL" "$CLONE_PATH"

echo ""
echo "=== Clone complete ==="
echo "Files in repository:"
ls -la "$CLONE_PATH" | head -15

# Clean up
rm -rf "$CLONE_PATH"
echo ""
echo "Cleanup complete."
