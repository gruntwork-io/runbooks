#!/bin/bash
# Simulates registering an existing account in Control Tower
#
# In a real implementation, this would:
# 1. Update accounts.yml with the new account entry
# 2. Create _new-account-requests/account-xxx.yml
# 3. Import the account into control-tower-multi-account-factory via OpenTofu
#
# For this demo, we simulate these steps and write the outputs.

set -e

ACCOUNT_NAME="{{ .inputs.AccountName }}"
ACCOUNT_ID="{{ .inputs.AccountId }}"
ACCOUNT_EMAIL="{{ .inputs.AccountEmail }}"
ENVIRONMENT="{{ .inputs.AccountEnvironment }}"
DEFAULT_REGION="{{ .inputs.DefaultRegion }}"
ORG_PREFIX="{{ .inputs.OrgNamePrefix }}"

log_info "=== Registering Account in Control Tower ==="
log_info "Account Name: $ACCOUNT_NAME"
log_info "Account ID:   $ACCOUNT_ID"
log_info "Email:        $ACCOUNT_EMAIL"
log_info "Environment:  $ENVIRONMENT"
log_info "Region:       $DEFAULT_REGION"

# Step 1: Simulate updating accounts.yml
log_info ""
log_info "Step 1: Updating accounts.yml..."
log_info "  Adding entry for $ACCOUNT_NAME ($ACCOUNT_ID)"
sleep 1
log_info "  accounts.yml updated successfully"

# Step 2: Simulate creating the new account request file
log_info ""
log_info "Step 2: Creating _new-account-requests/${ACCOUNT_NAME}.yml..."
sleep 1
log_info "  Account request file created"

# Step 3: Simulate importing into Control Tower
log_info ""
log_info "Step 3: Importing account into Control Tower Multi-Account Factory..."
log_info "  Running: tofu import aws_servicecatalog_provisioned_product.${ACCOUNT_NAME} ${ACCOUNT_ID}"
sleep 2
log_info "  Import simulation complete"

# Step 4: Verify account is visible in Organizations (real AWS call)
log_info ""
log_info "Step 4: Verifying account in AWS Organizations..."
if aws organizations list-accounts --query "Accounts[?Id=='${ACCOUNT_ID}'].{Id:Id,Name:Name,Status:Status}" --output table 2>/dev/null; then
  log_info "  Account found in AWS Organizations"
else
  log_warn "  Could not list accounts in Organizations (may not have permissions). Proceeding anyway."
fi

# Write outputs
echo "registered_account_name=$ACCOUNT_NAME" >> "$RUNBOOK_OUTPUT"
echo "registered_account_id=$ACCOUNT_ID" >> "$RUNBOOK_OUTPUT"
echo "registration_status=complete" >> "$RUNBOOK_OUTPUT"

# Generate the account request file for the file panel
mkdir -p "$GENERATED_FILES/_new-account-requests"
cat > "$GENERATED_FILES/_new-account-requests/${ACCOUNT_NAME}.yml" <<EOF
# Auto-generated account request for ingesting an existing account
account_name: ${ACCOUNT_NAME}
account_id: "${ACCOUNT_ID}"
account_email: ${ACCOUNT_EMAIL}
environment: ${ENVIRONMENT}
default_region: ${DEFAULT_REGION}
org_name_prefix: ${ORG_PREFIX}
source: existing-account-ingestion
EOF

log_info ""
log_info "=== Account Registration Complete ==="
log_info "Account $ACCOUNT_NAME ($ACCOUNT_ID) has been registered."

exit 0
