#!/bin/bash
echo "Fetching complex data..."
echo 'users=["alice","bob","charlie"]' >> "$RUNBOOK_OUTPUT"
echo 'teams={"engineering":{"lead":"alice","members":["bob","charlie"]},"product":{"lead":"diana","members":["eve"]}}' >> "$RUNBOOK_OUTPUT"
echo "Done! Outputs: users (list), teams (map)"
