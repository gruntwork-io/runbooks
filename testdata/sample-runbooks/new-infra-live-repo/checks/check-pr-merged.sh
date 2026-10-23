#!/bin/bash
set -e

# Verify that the scaffold PR has been merged. The Check's env prop sets
# PR_URL from the pr-scaffold block's output.

DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "🔍 Dry-run mode: Simulating PR merge check..."
    echo ""
    echo "[DRY-RUN] gh pr view ${PR_URL} --json state"
    echo ""
    echo "✅ Dry-run completed successfully!"
    exit 0
fi

echo "🔍 Checking if the pull request has been merged..."
echo "   PR: ${PR_URL}"
echo ""

STATE=$(gh pr view "${PR_URL}" --json state --jq '.state')

if [[ "$STATE" == "MERGED" ]]; then
    echo "✅ Pull request is merged!"
    exit 0
else
    echo "❌ Pull request is not yet merged (state: ${STATE})"
    echo ""
    echo "   Please review and merge the PR on GitHub:"
    echo "   ${PR_URL}"
    exit 1
fi
