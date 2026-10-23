#!/bin/bash
# TITLE comes from the block's env prop, as data.
log_info "Title: $TITLE"
echo "title=$TITLE" >> "$RUNBOOK_OUTPUT"
