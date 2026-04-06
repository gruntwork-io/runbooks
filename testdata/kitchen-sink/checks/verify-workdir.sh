#!/bin/bash
CWD="$(pwd)"
# macOS symlinks /tmp to /private/tmp
if [ "$CWD" = "/tmp" ] || [[ "$CWD" == /private/tmp* ]]; then
    echo "OK: Working directory is $CWD"
    exit 0
else
    echo "FAIL: Working directory is $CWD, expected /tmp"
    exit 1
fi
