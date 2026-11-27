#!/bin/bash
# Runs for $CLOSE_RUNS_FOR seconds (1 by default), or until it is stopped.
# Stopped (SIGTERM), it takes two seconds to clean up, then writes the file
# `stopped-<its pid>` in the folder it runs in.
cleanup() {
  sleep 2
  echo stopped > "stopped-$$"
  exit 0
}
trap cleanup TERM
echo started
sleep "${CLOSE_RUNS_FOR:-1}" &
wait $!
