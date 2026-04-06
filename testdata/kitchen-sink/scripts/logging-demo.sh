#!/bin/bash
log_info "This is an informational message"
log_warn "This is a warning message"
log_error "This is an error message (non-fatal in this demo)"
log_debug "This debug message only appears when DEBUG=true"
echo ""
echo "Logging demo complete. All four levels exercised."
