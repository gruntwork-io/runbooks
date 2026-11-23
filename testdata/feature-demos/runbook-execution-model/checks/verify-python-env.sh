#!/usr/bin/env bash
# Check that the variables the Python script wrote to RUNBOOK_ENV are set

echo "=== Checking for Python-set Environment Variables ==="
echo ""

check_var() {
    local var_name=$1
    local var_value="${!var_name}"

    if [ -n "$var_value" ]; then
        echo "✓ $var_name = $var_value"
        return 0
    else
        echo "✗ $var_name is NOT SET"
        return 1
    fi
}

all_passed=true

check_var "PYTHON_SET_VAR" || all_passed=false
check_var "PYTHON_COUNT" || all_passed=false
check_var "PYTHON_PROJECT" || all_passed=false

if [ -n "${PYTHON_LOCAL_ONLY:-}" ]; then
    echo "✗ PYTHON_LOCAL_ONLY is set, but os.environ changes should stay in the Python process"
    all_passed=false
else
    echo "✓ PYTHON_LOCAL_ONLY is not set (os.environ changes stay in the Python process)"
fi

echo ""

if [ "$all_passed" = true ]; then
    echo "The Python script's variables reached this block."
    exit 0
fi
echo "Run the Python block first."
exit 1
