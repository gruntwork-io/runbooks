#!/bin/bash

echo "=== Testing ls with colors ==="
echo ""

# Create some test files
DEMO_DIR="/tmp/ls-pty-demo"
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"
touch "$DEMO_DIR/file.txt"
mkdir "$DEMO_DIR/directory"
ln -s "$DEMO_DIR/file.txt" "$DEMO_DIR/symlink"

echo "Contents of $DEMO_DIR (with --color=auto):"
ls -la --color=auto "$DEMO_DIR" 2>/dev/null || ls -laG "$DEMO_DIR"

echo ""
echo "=== Cleanup ==="
rm -rf "$DEMO_DIR"
echo "Done."
