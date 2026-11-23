#!/usr/bin/env python3
"""Set session variables from Python by writing to RUNBOOK_ENV."""

import os

# os.environ only changes this process's environment, so later blocks don't see it
os.environ["PYTHON_LOCAL_ONLY"] = "not-for-later-blocks"

with open(os.environ["RUNBOOK_ENV"], "a") as f:
    f.write("PYTHON_SET_VAR=hello-from-python\n")
    f.write("PYTHON_COUNT=42\n")
    f.write("PYTHON_PROJECT=runbooks-python-test\n")

print("Wrote PYTHON_SET_VAR, PYTHON_COUNT and PYTHON_PROJECT to $RUNBOOK_ENV.")
