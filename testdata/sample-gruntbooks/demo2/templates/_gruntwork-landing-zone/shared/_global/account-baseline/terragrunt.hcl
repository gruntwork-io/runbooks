# ---------------------------------------------------------------------------------------------------------------------
# TERRAGRUNT CONFIGURATION
# This is the configuration for Terragrunt, an orchestrator for OpenTofu that helps keep your code DRY and
# maintainable: https://github.com/gruntwork-io/terragrunt
# ---------------------------------------------------------------------------------------------------------------------

terraform {
  source = "git@github.com:gruntwork-io/terraform-aws-control-tower.git//modules/landingzone/control-tower-app-account-baseline?ref=v0.7.5"

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
}

include "multi_region" {
  path = "${dirname(find_in_parent_folders("common.hcl"))}/_envcommon/common/multi_region_providers.hcl"
  # We want to reference the variables from the included config in this configuration, so we expose it.
  expose = true
}

# Include the component configuration, which has settings that are common for the component across all environments
include "envcommon" {
  path           = "${dirname(find_in_parent_folders("common.hcl"))}/_envcommon/landingzone/account-baseline-app-cis-base.hcl"
  merge_strategy = "deep"
  # We want to reference the variables from the included config in this configuration, so we expose it.
  expose = true
}

include "appcommon" {
  path           = "${dirname(find_in_parent_folders("common.hcl"))}/_envcommon/landingzone/account-baseline-app-cis-appaccount.hcl"
  merge_strategy = "deep"
}


# ---------------------------------------------------------------------------------------------------------------------
# Locals are named constants that are reusable within the configuration.
# ---------------------------------------------------------------------------------------------------------------------
locals {
  common_vars       = include.envcommon.locals.common_vars
  account_ids       = include.envcommon.locals.account_ids
  aws_region        = include.envcommon.locals.aws_region
  opt_in_regions    = include.multi_region.locals.opt_in_regions
  shared_account_id = local.account_ids["shared"]
  # A local for convenient access to the security account root ARN.
  security_account_root_arn = "arn:aws:iam::${local.account_ids.security}:root"
}

# ---------------------------------------------------------------------------------------------------------------------
# Module parameters to pass in. Note that these parameters are environment specific.
# ---------------------------------------------------------------------------------------------------------------------
inputs = {

  control_tower_management_account_id = local.account_ids["management"]

  ##################################
  # KMS keys
  ##################################

  kms_customer_master_keys = {
    # The `shared-secrets` key is used to encrypt AWS Secrets Manager secrets that are shared with other accounts.
    shared-secrets = {
      region                     = local.aws_region
      cmk_administrator_iam_arns = ["arn:aws:iam::${local.shared_account_id}:root"]
      cmk_user_iam_arns = [{
        name       = ["arn:aws:iam::${local.shared_account_id}:root"]
        conditions = []
      }]
      cmk_external_user_iam_arns = [
        for name, id in local.account_ids :
        "arn:aws:iam::${id}:root" if name != "shared"
      ]
    }

    # The `ami-encryption` key is used to encrypt AMIs that are shared with other accounts.
    ami-encryption = {
      region                     = local.aws_region
      replica_regions            = ["*"]
      cmk_administrator_iam_arns = ["arn:aws:iam::${local.shared_account_id}:root"]
      cmk_user_iam_arns = [{
        name = [
          "arn:aws:iam::${local.shared_account_id}:root",

          # The autoscaling service-linked role uses this key when invoking AutoScaling actions
          # (e.g. for adding and removing instances in autoscaling groups).
          "arn:aws:iam::${local.shared_account_id}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling",
        ]
        conditions = []
      }]
      cmk_external_user_iam_arns = [
        for name, id in local.account_ids :
        "arn:aws:iam::${id}:root" if name != "shared"
      ]
    }
  }

  # Set the default EBS key to be the AMI encryption key.
  ebs_use_existing_kms_keys = true
  ebs_kms_key_name          = "ami-encryption"

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
}
