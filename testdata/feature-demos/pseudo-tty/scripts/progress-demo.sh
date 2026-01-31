#!/bin/bash
set -e

echo "=== Simulating progress bar ==="
echo ""

# Simulate a progress bar that updates in place
for i in $(seq 0 10 100); do
    # Calculate number of # characters
    num_hashes=$((i / 10))
    
    # Build the progress bar string
    bar=""
    spaces=""
    for ((j=0; j<num_hashes; j++)); do
        bar="${bar}#"
    done
    for ((j=num_hashes; j<10; j++)); do
        spaces="${spaces} "
    done
    
    # Print progress on the same line using \r
    printf "\rProgress: [%s%s] %3d%%" "$bar" "$spaces" "$i"
    sleep 0.1
done

# Final newline
echo ""
echo ""
echo "=== Progress simulation complete ==="
