# Include the root `root.hcl` configuration, which has settings common across all environments & components.
include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "git::git@github.com:gruntwork-io/terraform-aws-cis-service-catalog.git//modules/observability/cloudtrail?ref=v0.58.0"
}

locals {
  common_vars  = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  account_ids  = local.common_vars.locals.account_ids
  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  account_name = local.account_vars.locals.account_name
  account_id   = local.account_ids[local.account_name]
}

inputs = {
  s3_bucket_name                        = "${local.common_vars.locals.name_prefix}-${local.account_name}-cloudtrail-logs"
  s3_mfa_delete                         = false
  num_days_after_which_archive_log_data = 30
  kms_key_administrator_iam_arns        = ["arn:aws:iam::${local.account_id}:root"]
  kms_key_user_iam_arns                 = ["arn:aws:iam::${local.account_id}:root"]
  allow_cloudtrail_access_with_iam      = true
  cloudwatch_logs_group_name            = "${local.common_vars.locals.name_prefix}-${local.account_name}-cloudtrail-logs"
}
