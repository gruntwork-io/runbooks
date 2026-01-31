#!/bin/bash

echo "=== Testing colored output ==="
echo ""

# Use tput if available, otherwise use raw ANSI codes
if command -v tput &> /dev/null; then
    echo "$(tput setaf 1)This should be RED$(tput sgr0)"
    echo "$(tput setaf 2)This should be GREEN$(tput sgr0)"
    echo "$(tput setaf 4)This should be BLUE$(tput sgr0)"
    echo "$(tput bold)This should be BOLD$(tput sgr0)"
else
    # Raw ANSI codes as fallback
    echo -e "\033[31mThis should be RED\033[0m"
    echo -e "\033[32mThis should be GREEN\033[0m"
    echo -e "\033[34mThis should be BLUE\033[0m"
    echo -e "\033[1mThis should be BOLD\033[0m"
fi

echo ""
echo "=== Color test complete ==="
echo "Note: Colors are stripped in Runbooks output for clean logs"
