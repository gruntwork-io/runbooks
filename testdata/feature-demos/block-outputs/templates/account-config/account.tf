# Account Configuration
# Generated from block outputs

# This template demonstrates using outputs from previous Command/Check blocks
# The account_id and region values come from the "create-account" block

locals {
  # Values from block outputs (populated by running the create-account Command)
  account_id = "{{ ._blocks.create_account.outputs.account_id }}"
  region     = "{{ ._blocks.create_account.outputs.region }}"
  
  # Values from this template's form inputs
  config_name = "{{ .config_name }}"
  description = "{{ .description }}"
}

# Example resource using the account ID from the previous step
resource "aws_iam_account_alias" "alias" {
  account_alias = "${local.config_name}-${local.account_id}"
}

# Example data source using the region from the previous step  
data "aws_region" "current" {
  name = local.region
}

output "account_summary" {
  description = local.description
  value = {
    account_id  = local.account_id
    region      = local.region
    config_name = local.config_name
  }
}
