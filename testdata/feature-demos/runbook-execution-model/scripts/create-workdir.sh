#!/usr/bin/env bash
# Create a directory for the next blocks to run in, and cd into it. The cd
# stays inside this script.

mkdir -p demo-workdir
echo "Created $(pwd)/demo-workdir"

cd demo-workdir
echo "This script is now in: $(pwd)"
echo "The next block starts in the session's directory again, unless it sets workingDir."
