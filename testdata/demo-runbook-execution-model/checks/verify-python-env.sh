#!/bin/bash
# Check if environment variables set by Python persisted

echo "=== Checking for Python-set Environment Variables ==="
echo ""

# Check each variable
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

echo ""

if [ "$all_passed" = true ]; then
    echo "All Python-set environment variables persisted!"
    exit 0
else
    echo "Some or all Python-set environment variables did NOT persist."
    echo "This is expected - Python's os.environ changes only affect its own process."
    echo "The bash wrapper captures env from bash, not from Python's subprocess."
    exit 1
fi

