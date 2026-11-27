#!/bin/bash
# Runs for $CLEANUP_RUNS_FOR seconds (1 by default), or until it is stopped.
# As it starts, it writes the paths of $RUNBOOK_LOG, in the block's folder,
# and $RUNBOOK_OUTPUT, in the run's, to `folders`, in the folder it runs in.
# Stopped (SIGTERM), it takes half a second to clean up, appends a line to
# each of the two, and writes to `trap-ran` "kept" or "gone" for each: gone
# if the append failed.
cleanup() {
  sleep 0.5
  if echo "cleaning up" >> "$RUNBOOK_LOG"; then log=kept; else log=gone; fi
  if echo "cleaned=yes" >> "$RUNBOOK_OUTPUT"; then out=kept; else out=gone; fi
  echo "$log $out" > trap-ran
  exit 0
}
trap cleanup TERM
printf '%s\n' "$RUNBOOK_LOG" "$RUNBOOK_OUTPUT" > folders
echo started
sleep "${CLEANUP_RUNS_FOR:-1}" &
wait $!
