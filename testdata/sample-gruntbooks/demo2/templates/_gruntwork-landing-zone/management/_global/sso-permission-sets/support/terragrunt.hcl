# ---------------------------------------------------------------------------------------------------------------------
# TERRAGRUNT CONFIGURATION
# This is the configuration for Terragrunt, an orchestrator for OpenTofu that supports locking and enforces best
# practices: https://github.com/gruntwork-io/terragrunt
# ---------------------------------------------------------------------------------------------------------------------

# Terragrunt will copy the OpenTofu configurations specified by the source parameter, along with any files in the
# working directory, into a temporary folder, and execute your OpenTofu commands in that folder.
terraform {
  source = "${local.source_base_url}?ref=v0.6.3"
}

include "root" {
  path = find_in_parent_folders("root.hcl")
}

locals {
  source_base_url = "git@github.com:gruntwork-io/terraform-aws-control-tower.git//modules/aws-sso/sso-permission-sets"
}

inputs = {
  name                 = "GWSupportAccess"
  description          = "Provides permission to access AWS Support"
  managed_policy_names = ["AWSSupportAccess"]
}
