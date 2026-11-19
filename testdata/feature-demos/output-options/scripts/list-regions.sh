#!/usr/bin/env bash
set -euo pipefail

# Stands in for a call that lists what's available right now, such as
# `az account list-locations`. It outputs the regions as a JSON array: each
# one a { value, label } object, so the dropdowns show "East US (eastus)" and
# store "eastus". Plain strings work too.
REGIONS='[{"value":"eastus","label":"East US (eastus)"},{"value":"westus2","label":"West US 2 (westus2)"},{"value":"northeurope","label":"North Europe (northeurope)"},{"value":"swedencentral","label":"Sweden Central (swedencentral)"}]'
echo "Found 4 regions"

echo "regions=$REGIONS" >> "$RUNBOOK_OUTPUT"
