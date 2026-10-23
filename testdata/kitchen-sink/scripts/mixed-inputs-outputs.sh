#!/bin/bash
# GREETING, COUNT and ACCOUNT_ID come from the block's env prop
echo "Greeting: $GREETING"
echo "Count: $COUNT"
echo "Account from outputs: $ACCOUNT_ID"
for i in $(seq 1 "$COUNT"); do
  echo "  Iteration $i: $GREETING!"
done
echo "result=mixed-success" >> "$RUNBOOK_OUTPUT"
