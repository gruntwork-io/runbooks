# ---------------------------------------------------------------------------------------------------------------------
# COMMON TERRAGRUNT CONFIGURATION
# This is the common override configuration for account-baseline-app for app accounts. This configuration will be merged
# into the environment configuration via an include block.
# NOTE: This configuration MUST be included with _envcommon/account-baseline-app-cis-base.hcl
# ---------------------------------------------------------------------------------------------------------------------

# ---------------------------------------------------------------------------------------------------------------------
# Locals are named constants that are reusable within the configuration.
# ---------------------------------------------------------------------------------------------------------------------
locals {
  # Automatically load common variables shared across all accounts
  common_vars         = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  account_ids         = local.common_vars.locals.account_ids
  security_account_id = local.account_ids["security"]

  # Automatically load region-level variables
  region_vars = read_terragrunt_config(find_in_parent_folders("region.hcl"))
  aws_region  = local.region_vars.locals.aws_region

  # Automatically load account-level variables
  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  account_name = local.account_vars.locals.account_name
}

# ---------------------------------------------------------------------------------------------------------------------
# MODULE PARAMETERS
# These are the variables we have to pass in to use the module specified in the terragrunt configuration above. This
# defines the parameters that are common across all environments.
# ---------------------------------------------------------------------------------------------------------------------
inputs = {
  ##################################
  # KMS grants
  ##################################

  # These grants allow the autoscaling service-linked role to access to the AMI encryption key so that it can launch
  # instances from AMIs that were shared from the shared account.
  # Note that these grants do not need to be created in the shared account, since the KMS key is owned by that account
  # and thus can directly provide permissions to the ASG service role.
  kms_grant_regions = merge(
    (
      local.account_name != "shared"
      ? {
        ami_encryption_key = local.aws_region
      }
      : {}
    )
  )
  kms_grants = merge(
    (
      local.account_name != "shared"
      ? {
        ami_encryption_key = {
          kms_cmk_arn       = "arn:aws:kms:{{ .DefaultRegion }}:${local.account_ids["shared"]}:alias/ami-encryption"
          grantee_principal = "arn:aws:iam::${local.account_ids[local.account_name]}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling"
          granted_operations = [
            "Encrypt",
            "Decrypt",
            "ReEncryptFrom",
            "ReEncryptTo",
            "GenerateDataKey",
            "DescribeKey"
          ]
        }
      }
      : {}
    )
  )

  ##################################
  # KMS keys
  ##################################

  kms_customer_master_keys = {
    # Generic KMS key that can be used for most app level encryption
    ("cmk-${local.account_name}") = {
      region                                = "{{ .DefaultRegion }}"
      allow_manage_key_permissions_with_iam = true
      enable_key_rotation                   = true
    }
  }

  ##################################
  # CONFIGURATION FOR CIS
  ##################################

  security_hub_associate_to_admin_account_id = local.account_ids.logs
  macie_administrator_account_id             = local.account_ids.logs

  # Disable reserved concurrent executions. This is defaulted to 1 in the module for thread safety,
  # however, new accounts do not have enough capacity to set this to 1, so we disable it for initial deployment
  # If you have issues with concurrent IAM certificate access, you can set this to 1.
  reserved_concurrent_executions = -1
}
