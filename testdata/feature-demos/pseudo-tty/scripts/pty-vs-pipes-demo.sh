#!/bin/bash
# This script demonstrates the difference between PTY and pipes execution modes

echo "=== PTY vs Pipes Detection Demo ==="
echo ""

# Check if we're running in a TTY
if [ -t 1 ]; then
    echo "[OK] STDOUT is a TTY (terminal)"
    echo "     -> Running in PTY mode"
    TTY_MODE="pty"
else
    echo "[NO] STDOUT is NOT a TTY"
    echo "     -> Running in Pipes mode"
    TTY_MODE="pipes"
fi

echo ""
echo "=== Progress Bar Demo ==="
echo "In PTY mode, this updates in-place. In pipes mode, each update is a new line."
echo ""

# Simulate a progress bar using ASCII characters for compatibility
for i in 10 20 30 40 50 60 70 80 90 100; do
    filled=$((i / 10))
    empty=$((10 - filled))
    bar=$(printf '%*s' "$filled" '' | tr ' ' '#')
    bar="${bar}$(printf '%*s' "$empty" '' | tr ' ' '-')"
    
    if [ "$TTY_MODE" = "pty" ]; then
        # In PTY mode, use carriage return to update in place
        printf "\rProgress: [%s] %3d%%" "$bar" "$i"
    else
        # In pipes mode, print each line separately
        echo "Progress: [$bar] $i%"
    fi
    sleep 0.2
done
echo ""  # Final newline

echo ""
echo "=== Conditional Output Demo ==="
echo "Some tools show different output based on TTY detection:"
echo ""

if [ -t 1 ]; then
    echo "[FULL OUTPUT] TTY detected - tools show rich output:"
    echo "   * Verbose status messages"
    echo "   * Progress indicators"
    echo "   * Colored output enabled"
    echo "   * Interactive prompts available"
else
    echo "[MINIMAL OUTPUT] No TTY - tools show basic output:"
    echo "   * Abbreviated messages"
    echo "   * No progress bars"
    echo "   * Plain text only"
fi

echo ""
echo "=== Demo Complete ==="
