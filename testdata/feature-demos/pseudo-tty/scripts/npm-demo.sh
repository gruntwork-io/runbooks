#!/bin/bash
set -e

DEMO_DIR="/tmp/npm-pty-demo"

# Clean up any existing directory
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"
cd "$DEMO_DIR"

echo "=== Creating minimal package.json ==="
cat > package.json << 'EOF'
{
  "name": "pty-demo",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.17.21"
  }
}
EOF

echo ""
echo "=== Running npm install (should show progress with PTY) ==="
npm install --no-fund --no-audit 2>&1 || echo "npm not available, skipping"

echo ""
echo "=== Cleanup ==="
rm -rf "$DEMO_DIR"
echo "Done."
