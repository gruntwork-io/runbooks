#!/usr/bin/env bash
# Runs with workingDir="demo-workdir", so it starts in that directory

current_dir=$(pwd)
echo "Current directory: $current_dir"

if [ "$(basename "$current_dir")" != "demo-workdir" ]; then
    echo "❌ Expected to run in demo-workdir"
    exit 1
fi

echo "✅ This block runs in demo-workdir, as its workingDir prop says."
