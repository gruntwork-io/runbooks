#!/usr/bin/env bash
# TITLE comes from the block's env prop, as data.
echo "Title: $TITLE" >> "$RUNBOOK_INFO_LOG"
echo "title=$TITLE" >> "$RUNBOOK_OUTPUT"
