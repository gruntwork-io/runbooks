# ---------------------------------------------------------------------------------------------------------------------
# TERRAGRUNT CONFIGURATION
# This is the configuration for Terragrunt, an orchestrator for OpenTofu that supports locking and enforces best
# practices: https://github.com/gruntwork-io/terragrunt
# ---------------------------------------------------------------------------------------------------------------------

terraform {
  source = "git::git@github.com:gruntwork-io/terraform-aws-cis-service-catalog.git//modules/security/iam-password-policy?ref=v0.50.0"
}

# Include the root terragrunt configuration, which has settings common across all environments & components.
include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  iam_password_policy_minimum_password_length = 14

  require_numbers              = true
  require_symbols              = true
  require_lowercase_characters = true
  require_uppercase_characters = true
  max_password_age             = 0

  # WARNING: Setting the below value to "true" with the following conditions can lead to administrative account lockout:
  #
  # 1) You have only a single administrative IAM user
  # 2) You do not have access to the root account
  #
  #iam_password_policy_hard_expiry = true
}
