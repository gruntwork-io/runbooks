#!/bin/bash
echo "Setting up block outputs..."
echo "account_id=123456789012" >> "$RUNBOOK_OUTPUT"
echo "region=us-west-2" >> "$RUNBOOK_OUTPUT"
echo "project_name=kitchen-sink" >> "$RUNBOOK_OUTPUT"
echo "Done! Outputs: account_id, region, project_name"
