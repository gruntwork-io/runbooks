#!/usr/bin/env bash
mkdir -p ks-workdir
echo "Created $(pwd)/ks-workdir"
# Stays in this script: the next block starts in the session's directory
cd ks-workdir
echo "Changed to: $(pwd)"
