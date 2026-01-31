#!/bin/bash

echo "=== Simulating progress bar ==="
echo ""

# Simulate a progress bar that updates in place
for i in {0..100..10}; do
    # Print progress on the same line using \r
    printf "\rProgress: [%-10s] %d%%" $(printf '#%.0s' $(seq 1 $((i/10)))) $i
    sleep 0.1
done

# Final newline
echo ""
echo ""
echo "=== Progress simulation complete ==="
