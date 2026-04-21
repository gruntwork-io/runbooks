#!/bin/bash
set -e

# Script to upgrade GitHub CLI (gh) to the latest version
# Detects how gh is installed and uses the appropriate upgrade method

echo "Checking current gh version..."
if ! command -v gh &> /dev/null; then
    echo "Error: gh is not installed on this system"
    exit 1
fi

current_version=$(gh --version | head -n 1)
echo "Current version: $current_version"
echo ""

# Function to check if a command exists
command_exists() {
    command -v "$1" &> /dev/null
}

# Try gh upgrade first (self-update)
if gh upgrade --help &> /dev/null; then
    echo "Upgrading gh using built-in 'gh upgrade' command..."
    gh upgrade
    exit 0
fi

# Detect and use the appropriate package manager
if command_exists brew && brew list gh &> /dev/null; then
    echo "Detected Homebrew installation. Upgrading..."
    brew upgrade gh
    
elif command_exists apt && dpkg -l | grep -q "^ii.*gh "; then
    echo "Detected apt installation. Upgrading..."
    sudo apt update
    sudo apt install gh
    
elif command_exists dnf && dnf list installed gh &> /dev/null; then
    echo "Detected dnf installation. Upgrading..."
    sudo dnf upgrade gh
    
elif command_exists yum && yum list installed gh &> /dev/null; then
    echo "Detected yum installation. Upgrading..."
    sudo yum upgrade gh
    
elif command_exists pacman && pacman -Q gh &> /dev/null; then
    echo "Detected pacman installation. Upgrading..."
    sudo pacman -Syu gh
    
elif command_exists choco && choco list --local-only | grep -q "^gh "; then
    echo "Detected Chocolatey installation. Upgrading..."
    choco upgrade gh
    
elif command_exists scoop && scoop list | grep -q "gh "; then
    echo "Detected Scoop installation. Upgrading..."
    scoop update gh
    
elif command_exists winget; then
    echo "Detected winget. Attempting upgrade..."
    winget upgrade --id GitHub.cli
    
else
    echo "Error: Could not determine how gh was installed."
    echo "Please upgrade gh manually using the method you used to install it."
    echo ""
    echo "Common methods:"
    echo "  - Homebrew: brew upgrade gh"
    echo "  - apt: sudo apt update && sudo apt install gh"
    echo "  - dnf: sudo dnf upgrade gh"
    echo "  - Try: gh upgrade (if supported)"
    exit 1
fi

echo ""
echo "Upgrade complete!"
new_version=$(gh --version | head -n 1)
echo "New version: $new_version"
