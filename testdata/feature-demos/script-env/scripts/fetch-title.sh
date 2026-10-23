#!/bin/bash
# A title a pull request can have. A script that pasted it into its own
# source would run each of the touch commands in it.
cat >> "$RUNBOOK_OUTPUT" <<'TITLE'
title=Fix typo $(touch "$GENERATED_FILES/pwned") `touch "$GENERATED_FILES/pwned"` "; touch "$GENERATED_FILES/pwned"; echo "
TITLE
log_info "Published the title"
