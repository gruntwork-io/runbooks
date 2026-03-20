#!/bin/bash
set -e

# Detect the AWS account ID from the authenticated session.

DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "🔍 Dry-run mode: Simulating account detection..."
    echo ""
    echo "[DRY-RUN] aws sts get-caller-identity --query Account --output text"
    echo ""
    echo "account_id=123456789012" >> "$RUNBOOK_OUTPUT"
    echo "✅ Dry-run completed successfully!"
    exit 0
fi

echo "🔍 Detecting AWS account ID..."

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo ""
echo "✅ AWS Account ID: ${ACCOUNT_ID}"

echo "account_id=${ACCOUNT_ID}" >> "$RUNBOOK_OUTPUT"
