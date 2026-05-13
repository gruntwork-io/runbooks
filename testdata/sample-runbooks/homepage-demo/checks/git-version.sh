#!/bin/bash
# Check that Git is installed.
git_version=$(git --version 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "Git is not installed"
  exit 1
fi
echo "$git_version is installed"
