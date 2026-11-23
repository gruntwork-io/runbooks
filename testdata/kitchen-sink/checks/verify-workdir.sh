#!/usr/bin/env bash
# Runs with workingDir="ks-workdir"
CWD="$(pwd)"
if [ "$(basename "$CWD")" = "ks-workdir" ]; then
    echo "OK: Working directory is $CWD"
    exit 0
fi
echo "FAIL: Working directory is $CWD, expected ks-workdir"
exit 1
