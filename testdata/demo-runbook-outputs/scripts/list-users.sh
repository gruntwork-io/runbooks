#!/bin/bash
echo "Fetching users from organization..."
sleep 1

# Simulate fetching a list of users
USERS='["alice","bob","charlie","diana"]'

# Simulate fetching a more complex structure (map/object)
TEAMS='{"engineering":{"lead":"alice","members":["bob","charlie"]},"product":{"lead":"diana","members":["eve"]}}'

echo "Found users: $USERS"
echo "Found teams: $TEAMS"

# Output as JSON strings for downstream blocks
echo "users=$USERS" >> "$RUNBOOK_OUTPUT"
echo "teams=$TEAMS" >> "$RUNBOOK_OUTPUT"
