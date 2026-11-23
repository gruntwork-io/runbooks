#!/usr/bin/env bash
# Runs without workingDir, so it starts in the session's directory, whatever
# directory an earlier script cd'd into

current_dir=$(pwd)
echo "Current directory: $current_dir"

if [ "$(basename "$current_dir")" = "demo-workdir" ]; then
    echo "❌ An earlier script's cd carried into this block"
    exit 1
fi
if [ ! -d demo-workdir ]; then
    echo "❌ Expected demo-workdir under the session's directory. Run the block that creates it first."
    exit 1
fi

echo "✅ This block starts in the session's directory. The earlier cd stayed in its own script."
