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
  source = "git@github.com:gruntwork-io/terraform-aws-control-tower.git//modules/landingzone/control-tower-app-account-baseline?ref=v0.8.1"

  # This module deploys some resources (e.g., GuardDuty) across all AWS regions, each of which needs its own provider,
  # which in OpenTofu means a separate process. To avoid all these processes thrashing the CPU, which leads to network
  # connectivity issues, we limit the parallelism here.
  extra_arguments "parallelism" {
    commands  = get_terraform_commands_that_need_parallelism()
    arguments = get_env("TG_ENABLE_PARALLELISM_LIMIT", "false") == "true" ? ["-parallelism=1"] : []
  }
}

# Include the root terragrunt configuration, which has settings common across all environments & components.
include "root" {
  path = find_in_parent_folders("root.hcl")
  # We want to reference the locals from root
  expose = true
}

include "multi_region" {
  path = "${dirname(find_in_parent_folders("common.hcl"))}/_envcommon/common/multi_region_providers.hcl"
  # We want to reference the variables from the included config in this configuration, so we expose it.
  expose = true
}

# Include the component configuration, which has settings that are common for the component across all environments
include "envcommon" {
  path = "${dirname(find_in_parent_folders("common.hcl"))}/_envcommon/landingzone/account-baseline-app-cis-base.hcl"
  # We want to reference the variables from the included config in this configuration, so we expose it.
  expose = true
}


# ---------------------------------------------------------------------------------------------------------------------
# Locals are named constants that are reusable within the configuration.
# ---------------------------------------------------------------------------------------------------------------------
locals {
  common_vars  = include.envcommon.locals.common_vars
  account_info = include.envcommon.locals.account_info
  account_id   = include.envcommon.locals.account_id
  account_name = include.envcommon.locals.account_name
  account_ids  = include.envcommon.locals.account_ids
  aws_region   = include.envcommon.locals.aws_region
  state_bucket = include.root.locals.state_bucket

  non_logs_account_ids = [
    for name, id in local.account_ids :
    id if name != "logs"
  ]

  # For CIS Compliance, we use the logs account as the administrator account for some services (SecurityHub and Macie),
  # so we define a local here for the accounts that need to report to this account.
  external_member_accounts = {
    for name, account_info in local.account_info :
    name => {
      account_id    = account_info.id
      email         = account_info.email
      disable_macie = lookup(account_info, "disable_macie", false)
      disable_security_hub = lookup(account_info, "disable_security_hub", false)
    }
    if name != "logs" && name != "management"
  }

  external_macie_accounts = {
    for name, account_info in local.external_member_accounts :
    name => {
      account_id = account_info.account_id
      email      = account_info.email
    }
    if !account_info.disable_macie
  }

  external_security_hub_accounts = {
    for name, account_info in local.external_member_accounts :
    name => {
      account_id = account_info.account_id
      email      = account_info.email
    }
    if !account_info.disable_security_hub
  }

  # A local for convenient access to the security account root ARN.
  security_account_root_arn = "arn:aws:iam::${local.account_ids.security}:root"
}

# ---------------------------------------------------------------------------------------------------------------------
# Module parameters to pass in. Note that these parameters are environment specific.
# ---------------------------------------------------------------------------------------------------------------------
inputs = {

  control_tower_management_account_id = local.account_ids["management"]

  ##################################
  # CONFIGURATION FOR CIS
  ##################################
  config_should_create_s3_bucket      = true
  cloudtrail_s3_bucket_already_exists = false
  # Aggregate security hub results in {{ .DefaultRegion }}
  security_hub_aggregate_region = "{{ .DefaultRegion }}"

  # The logs account acts as the administrator account for SecurityHub and Macie, so add the rule to invite the other
  # accounts.
  security_hub_external_member_accounts = local.external_security_hub_accounts
  macie_external_member_accounts        = local.external_macie_accounts

  macie_buckets_to_analyze = {
    // Manually override {{ .DefaultRegion }} to include config and cloudtrail
    // This was already set up (manually, maybe?) and applies were failing
    // due to the following error -
    // Error: error updating Macie ClassificationJob (xxx): InvalidParameter: 1 validation error(s) found.
    // │ - missing required field, UpdateClassificationJobInput.JobStatus.
    "{{ .DefaultRegion }}" : [
      local.state_bucket,
      "aws-controltower-logs-${local.account_id}-${local.aws_region}"
    ]
  }
}
