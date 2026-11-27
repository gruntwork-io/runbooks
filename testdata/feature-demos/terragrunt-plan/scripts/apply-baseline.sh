#!/bin/bash
# Writes a small Terragrunt stack to a new directory and applies it, so the
# next step has something to change. It stands in for an identity in each of
# three subscriptions, using only terraform_data, which is built into
# OpenTofu: no provider downloads, no cloud account, only local state files.
set -euo pipefail

stack_dir="$(mktemp -d)/stack"
mkdir -p "$stack_dir/modules/identity" "$stack_dir/subscriptions"/{dev,staging,prod}

cat > "$stack_dir/modules/identity/main.tf" <<'HCL'
# A stand-in for a cloud identity module. It uses only terraform_data, which
# is built into OpenTofu, so planning it needs no provider downloads and no
# cloud account.

variable "subscription" {
  type = string
}

variable "location" {
  type = string
}

variable "role_actions" {
  type = list(string)
}

variable "keep_legacy_assignment" {
  type = bool
}

variable "client_secret" {
  type      = string
  sensitive = true
}

resource "terraform_data" "role_definition" {
  input = {
    name    = "pipelines-${var.subscription}"
    scope   = "/subscriptions/${var.subscription}"
    actions = var.role_actions
  }
}

# Moving the identity to another location replaces it.
resource "terraform_data" "managed_identity" {
  input            = { name = "pipelines-${var.subscription}", location = var.location }
  triggers_replace = [var.location]
}

resource "terraform_data" "federated_credential" {
  input = {
    identity = terraform_data.managed_identity.id
    secret   = var.client_secret
  }
}

resource "terraform_data" "legacy_role_assignment" {
  count = var.keep_legacy_assignment ? 1 : 0
  input = { role = "Contributor", scope = "/subscriptions/${var.subscription}" }
}

output "identity_id" {
  value = terraform_data.managed_identity.id
}
HCL

cat > "$stack_dir/root.hcl" <<'HCL'
# PLAN_DEMO_CHANGE=true is the change under review: it adds a role action,
# drops the legacy role assignment and, in staging, moves the identity.
locals {
  change       = get_env("PLAN_DEMO_CHANGE", "false") == "true"
  subscription = basename(get_original_terragrunt_dir())
}

terraform {
  source = "${get_parent_terragrunt_dir()}/modules/identity"
}
HCL

for subscription in dev staging prod; do
  cat > "$stack_dir/subscriptions/$subscription/terragrunt.hcl" <<'HCL'
include "root" {
  path   = find_in_parent_folders("root.hcl")
  expose = true
}

locals {
  change = include.root.locals.change
  sub    = include.root.locals.subscription
}

inputs = {
  subscription = local.sub
  # prod isn't part of this change
  location = local.change && local.sub == "staging" ? "westus2" : "eastus"
  role_actions = local.change && local.sub != "prod" ? [
    "Microsoft.Resources/subscriptions/resourceGroups/read",
    "Microsoft.Authorization/roleAssignments/write",
  ] : ["Microsoft.Resources/subscriptions/resourceGroups/read"]
  keep_legacy_assignment = !(local.change && local.sub != "prod")
  client_secret          = "s3cr3t-${local.sub}"
}
HCL
done

cd "$stack_dir"
log_info "Applying the starting state in $stack_dir"
terragrunt run --all --non-interactive -- apply -auto-approve

echo "stack_dir=$stack_dir" >> "$RUNBOOK_OUTPUT"
