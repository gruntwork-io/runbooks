#!/bin/bash
# Create project and set outputs

set -e

# Generate a project ID
PROJECT_ID=$(date +%s | shasum | head -c 12)

echo "Creating project with ID: $PROJECT_ID"

# Export project name to environment for other blocks
export PROJECT_NAME="${PROJECT_NAME:-test-project}"

# Set outputs for other blocks to use
echo "project_id=$PROJECT_ID" >> "$RUNBOOK_OUTPUT"
echo "status=created" >> "$RUNBOOK_OUTPUT"

echo "Project created successfully!"
echo "Project ID: $PROJECT_ID"
