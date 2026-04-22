# ---------------------------------------------------------------------------------------------------------------------
# TERRAGRUNT CONFIGURATION
# This is the configuration for Terragrunt, an orchestrator for OpenTofu that helps keep your code DRY and
# maintainable: https://github.com/gruntwork-io/terragrunt
# ---------------------------------------------------------------------------------------------------------------------

terraform {
  source = "git@github.com:gruntwork-io/terraform-aws-control-tower.git//modules/landingzone/control-tower-security-account-baseline?ref=v0.7.5"

  # This module deploys some resources (e.g., GuardDuty) across all AWS regions, each of which needs its own provider,
  # which in OpenTofu means a separate process. To avoid all these processes thrashing the CPU, which leads to network
  # connectivity issues, we limit the parallelism here.
  extra_arguments "parallelism" {
    commands  = get_terraform_commands_that_need_parallelism()
    arguments = get_env("TG_ENABLE_PARALLELISM_LIMIT", "false") == "true" ? ["-parallelism=2"] : []
  }
}

# Include all settings from the root terragrunt.hcl file
include "root" {
  path = find_in_parent_folders("root.hcl")
  # We want to reference the locals from root
  expose = true
}

include "multi_region" {
  path   = "${dirname(find_in_parent_folders("common.hcl"))}/_envcommon/common/multi_region_providers.hcl"
  expose = true
}

# ---------------------------------------------------------------------------------------------------------------------
# Locals are named constants that are reusable within the configuration.
# ---------------------------------------------------------------------------------------------------------------------
locals {
  # Automatically load common variables shared across all accounts
  common_vars = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  name_prefix = local.common_vars.locals.name_prefix

  # Automatically load account-level variables
  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  account_name = local.account_vars.locals.account_name
  account_ids  = local.common_vars.locals.account_ids
  account_id   = local.account_ids[local.account_name]
  state_bucket = include.root.locals.state_bucket

  # Automatically load region-level variables
  region_vars               = read_terragrunt_config(find_in_parent_folders("region.hcl"))
  aws_region                = local.region_vars.locals.aws_region
  security_account_root_arn = "arn:aws:iam::${local.account_ids.security}:root"


  #  cross_account_groups = try(
  #    yamldecode(
  #      templatefile(
  #        "cross_account_groups.yml",
  #        {
  #          account_ids = {
  #            for name, id in local.account_ids :
  #            name => id if name != "security" && name != "root"
  #          }
  #        },
  #      ),
  #    ),
  #    {},
  #  )

  # The following locals are used for constructing multi region provider configurations for the underlying module.
  all_aws_regions = include.multi_region.locals.all_aws_regions
  opt_in_regions  = include.multi_region.locals.opt_in_regions

  # A local for convenient access to the macie variables
  macie_bucket_name  = lower("${local.common_vars.locals.macie_bucket_name_prefix}-${local.account_name}")
  macie_kms_key_name = local.common_vars.locals.macie_kms_key_name

  # This should contain an incoming webhook URL for the Slack channel #cis-audit
  # This secret lives in the shared-services account and is setup for cross account access so that every account can
  # stream the CIS alarms to Slack.
  #  slack_webhook_url_secrets_manager_arn = "arn:aws:secretsmanager:us-east-1:${local.account_ids.shared-services}:secret:SlackWebhookURLForCISAudit-yybOoL"
}

# ---------------------------------------------------------------------------------------------------------------------
# MODULE PARAMETERS
# These are the variables we have to pass in to use the module specified in the terragrunt configuration above.
# ---------------------------------------------------------------------------------------------------------------------
inputs = {
  name_prefix = local.name_prefix

  iam_password_policy_hard_expiry             = false
  iam_password_policy_minimum_password_length = 16
  iam_password_policy_max_password_age        = 30

  ##################################
  # IAM Group settings
  ##################################

  iam_group_name_auto_deploy = "_machine.eks-auto-deploy"
  #  should_create_iam_group_read_only                = true
  #  should_create_iam_group_logs                     = true
  #  should_create_iam_group_user_self_mgmt           = true
  should_create_iam_group_cross_account_access_all = false


  ##################################
  # Cross-account IAM role permissions
  ##################################

  # Create groups that allow IAM users in this account to assume roles in your other AWS accounts.
  #  iam_groups_for_cross_account_access = local.cross_account_groups.cross_account_groups

  # Allow these accounts to have read access to IAM groups and the public SSH keys of users in the group.
  #  allow_ssh_grunt_access_from_other_account_arns = sort([
  #    for name, id in local.account_ids :
  #    "arn:aws:iam::${id}:root" if name != "security"
  #  ])
  #
  #  cross_account_access_all_group_name = "_account.all"

  ##################################
  # CIS compliance settings
  ##################################

  # Configure SecurityHub
  security_hub_associate_to_admin_account_id = local.account_ids.logs

  # Disable CIS 1.2 because 1.4 is enabled by default.
  security_hub_enable_cis_check = false

  # Configure opt in regions for each multi region service based on locally configured setting.
  guardduty_opt_in_regions           = local.opt_in_regions
  kms_cmk_opt_in_regions             = local.opt_in_regions
  ebs_opt_in_regions                 = local.opt_in_regions
  iam_access_analyzer_opt_in_regions = local.opt_in_regions
  security_hub_opt_in_regions        = local.opt_in_regions

  # Configure Amazon Macie
  create_macie_bucket            = true
  macie_bucket_name              = local.macie_bucket_name
  macie_create_kms_key           = true
  macie_kms_key_name             = local.macie_kms_key_name
  macie_kms_key_users            = ["arn:aws:iam::${local.account_id}:root"]
  macie_opt_in_regions           = local.opt_in_regions
  macie_administrator_account_id = local.account_ids.logs
  macie_buckets_to_analyze = {
    (local.aws_region) = [local.state_bucket]
  }

  ##################################
  # KMS keys and grants
  ##################################

  kms_customer_master_keys = {
    # The `cloudwatch-alarm-sns-encryption` key is used to encrypt the SNS topics in a way that allows CloudWatch
    # Alarms to still access it.
    cloudwatch-alarm-sns-encryption = {
      region                     = local.aws_region
      cmk_administrator_iam_arns = ["arn:aws:iam::${local.account_id}:root"]
      cmk_service_principals = [{
        name    = "cloudwatch.amazonaws.com"
        actions = ["kms:Decrypt", "kms:GenerateDataKey*"]
      }]
    }
  }

  # A list of account root ARNs that should be able to assume the auto deploy role.
  allow_auto_deploy_from_other_account_arns = [
    # External CI/CD systems may use an IAM user in the security account to perform deployments.
    local.security_account_root_arn,
  ]

  # Assuming the auto-deploy role will grant access to these services.
  auto_deploy_permissions = [
    "iam:GetRole",
    "iam:GetRolePolicy",
  ]

  # Disable reserved concurrent executions. This is defaulted to 1 in the module for thread safety,
  # however, new accounts do not have enough capacity to set this to 1, so we disable it for initial deployment
  # If you have issues with concurrent IAM certificate access, you can set this to 1.
  reserved_concurrent_executions = -1
}
