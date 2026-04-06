#!/bin/bash
echo "Greeting: {{ .inputs.Greeting }}"
echo "Count: {{ .inputs.Count }}"
echo "Account from outputs: {{ .outputs.setup_outputs.account_id }}"
for i in $(seq 1 {{ .inputs.Count }}); do
  echo "  Iteration $i: {{ .inputs.Greeting }}!"
done
echo "result=mixed-success" >> "$RUNBOOK_OUTPUT"
