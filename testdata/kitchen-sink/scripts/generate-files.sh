#!/bin/bash
set -euo pipefail

if [ -z "${GENERATED_FILES:-}" ]; then
    echo "Error: GENERATED_FILES is not set"
    exit 1
fi

echo "Writing files to $GENERATED_FILES..."

mkdir -p "$GENERATED_FILES/scripts"

cat > "$GENERATED_FILES/config.json" << 'EOF'
{
  "generated": true,
  "source": "kitchen-sink",
  "timestamp": "2024-01-01T00:00:00Z"
}
EOF

cat > "$GENERATED_FILES/scripts/deploy.sh" << 'EOF'
#!/bin/bash
echo "Deploying..."
EOF
chmod +x "$GENERATED_FILES/scripts/deploy.sh"

echo "Generated 2 files: config.json, scripts/deploy.sh"
