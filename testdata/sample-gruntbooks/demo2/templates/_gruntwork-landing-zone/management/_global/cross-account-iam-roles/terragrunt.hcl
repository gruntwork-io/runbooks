# ---------------------------------------------------------------------------------------------------------------------
# TERRAGRUNT CONFIGURATION
# This is the configuration for Terragrunt, an orchestrator for OpenTofu that supports locking and enforces best
# practices: https://github.com/gruntwork-io/terragrunt
# ---------------------------------------------------------------------------------------------------------------------

# Terragrunt will copy the OpenTofu configurations specified by the source parameter, along with any files in the
# working directory, into a temporary folder, and execute your OpenTofu commands in that folder.
terraform {
  source = "git@github.com:gruntwork-io/terraform-aws-security.git//modules/cross-account-iam-roles?ref=v0.75.10"
}

# Include the root terragrunt configuration, which has settings common across all environments & components.
include "root" {
  path = find_in_parent_folders("root.hcl")
}

locals {
  # Automatically load common variables shared across all accounts
  common_vars = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  account_ids = local.common_vars.locals.account_ids

  # A local for convenient access to the security account root ARN.
  security_account_root_arn = "arn:aws:iam::${local.account_ids.security}:root"
}

# ---------------------------------------------------------------------------------------------------------------------
# MODULE PARAMETERS
# These variables are expected to be passed in by the operator
# ---------------------------------------------------------------------------------------------------------------------

# Set up the inputs so we only allow billing access to the root account via the security account.
inputs = {
  should_require_mfa                           = true
  allow_billing_access_from_other_account_arns = [local.security_account_root_arn]
  allow_support_access_from_other_account_arns = [local.security_account_root_arn]
}
