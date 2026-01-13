#!/usr/bin/env python3
"""Test that Python can READ environment variables set by earlier bash scripts."""

import os
import sys

print("=== Python Reading Bash-Set Environment Variables ===")
print(f"Python version: {sys.version.split()[0]}")
print()

# Read environment variables set by the bash script in Block 1
demo_var = os.environ.get("DEMO_VAR")
demo_count = os.environ.get("DEMO_COUNT")
demo_project = os.environ.get("DEMO_PROJECT")

print("Checking for environment variables set by bash in Block 1:")
print()

all_found = True

if demo_var:
    print(f"  ✓ DEMO_VAR = {demo_var}")
else:
    print("  ✗ DEMO_VAR is NOT SET")
    all_found = False

if demo_count:
    print(f"  ✓ DEMO_COUNT = {demo_count}")
else:
    print("  ✗ DEMO_COUNT is NOT SET")
    all_found = False

if demo_project:
    print(f"  ✓ DEMO_PROJECT = {demo_project}")
else:
    print("  ✗ DEMO_PROJECT is NOT SET")
    all_found = False

print()

if all_found:
    print("✅ Python successfully read all bash-set environment variables!")
    sys.exit(0)
else:
    print("❌ Some environment variables were not found.")
    print("   Make sure to run Block 1 (Set Initial Environment Variables) first!")
    sys.exit(1)

