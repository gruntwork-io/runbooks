#!/bin/bash
# Starts sleeps in this script's process group, writes this script's pid and
# theirs to $SLEEPS_PIDS_FILE, and waits for them.
#
# - SLEEPS_IGNORE_STOP set: the script and its two sleeps ignore SIGINT and
#   SIGTERM, so only SIGKILL ends them.
# - SLEEPS_CLEANED_FILE set: SIGTERM ends the script, but two subshells run
#   with their output redirected, so they outlive it. The first takes a second
#   to clean up on SIGTERM, then writes "cleaned" to that file; the second
#   ignores SIGTERM.
pids=$SLEEPS_PIDS_FILE
echo $$ >> "$pids"
if [ -n "$SLEEPS_CLEANED_FILE" ]; then
  (
    trap 'sleep 1; echo cleaned >> "$SLEEPS_CLEANED_FILE"; exit' TERM
    sleep 300 &
    echo $! >> "$pids"
    wait
  ) > /dev/null 2>&1 &
  echo $! >> "$pids"
  (trap '' TERM; exec sleep 300) > /dev/null 2>&1 &
  echo $! >> "$pids"
else
  if [ -n "$SLEEPS_IGNORE_STOP" ]; then trap '' INT TERM; fi
  sleep 300 &
  echo $! >> "$pids"
  sleep 300 &
  echo $! >> "$pids"
fi
wait
