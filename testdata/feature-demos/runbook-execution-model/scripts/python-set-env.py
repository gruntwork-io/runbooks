#!/usr/bin/env python3
"""Test setting environment variables from Python"""

import os
import sys

print("=== Python Setting Environment Variables ===")
print(f"Python version: {sys.version}")
print()

# Try to set environment variables
os.environ["PYTHON_SET_VAR"] = "hello-from-python"
os.environ["PYTHON_COUNT"] = "42"
os.environ["PYTHON_PROJECT"] = "runbooks-python-test"

print("Environment variables set in Python:")
print(f"  PYTHON_SET_VAR = {os.environ.get('PYTHON_SET_VAR')}")
print(f"  PYTHON_COUNT = {os.environ.get('PYTHON_COUNT')}")
print(f"  PYTHON_PROJECT = {os.environ.get('PYTHON_PROJECT')}")
print()

# Also try using export-like syntax by writing to a file
# This is a workaround that some systems use
print("Note: Python's os.environ only affects the current process.")
print("For env vars to persist, the execution model needs to capture them.")
print()
print("Python script completed!")

