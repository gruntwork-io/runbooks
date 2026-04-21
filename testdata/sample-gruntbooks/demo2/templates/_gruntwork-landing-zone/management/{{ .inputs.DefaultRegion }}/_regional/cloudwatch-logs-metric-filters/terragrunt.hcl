# ---------------------------------------------------------------------------------------------------------------------
# TERRAGRUNT CONFIGURATION
# This is the configuration for Terragrunt, an orchestrator for OpenTofu that helps keep your code DRY and
# maintainable: https://github.com/gruntwork-io/terragrunt
# ---------------------------------------------------------------------------------------------------------------------

# Terragrunt will copy the OpenTofu configurations specified by the source parameter, along with any files in the
# working directory, into a temporary folder, and execute your OpenTofu commands in that folder. If you're iterating
# locally, you can use --terragrunt-source /path/to/local/checkout/of/module to override the source parameter to a
# local check out of the module for faster iteration.
terraform {
  source = "git@github.com:gruntwork-io/terraform-aws-cis-service-catalog.git//modules/observability/cloudwatch-logs-metric-filters?ref=v0.50.0"
}

# Include all settings from the root terragrunt.hcl file
include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  cloudwatch_logs_group_name = "aws-controltower/CloudTrailLogs"
}
