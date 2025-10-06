#!/bin/bash
# Check if Terraform or OpenTofu is installed

set -e

if command -v tofu &> /dev/null; then
    echo "✓ OpenTofu is installed: $(tofu version | head -1)"
    exit 0
elif command -v terraform &> /dev/null; then
    echo "✓ Terraform is installed: $(terraform version | head -1)"
    exit 0
else
    echo "✗ Neither Terraform nor OpenTofu is installed"
    echo "Please install one of them to continue:"
    echo "  - OpenTofu: https://opentofu.org/docs/intro/install/"
    echo "  - Terraform: https://www.terraform.io/downloads"
    exit 1
fi

