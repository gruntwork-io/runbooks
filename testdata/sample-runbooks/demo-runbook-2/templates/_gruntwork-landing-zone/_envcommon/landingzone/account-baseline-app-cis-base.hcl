# ---------------------------------------------------------------------------------------------------------------------
# COMMON TERRAGRUNT CONFIGURATION
# This is the common component configuration for landingzone/account-baseline-app-base. The common variables for each environment to
# deploy landingzone/account-baseline-app-base are defined here. This configuration will be merged into the environment configuration
# via an include block.
# ---------------------------------------------------------------------------------------------------------------------

# ---------------------------------------------------------------------------------------------------------------------
# Locals are named constants that are reusable within the configuration.
# ---------------------------------------------------------------------------------------------------------------------
locals {
  # Automatically load common variables shared across all accounts
  common_vars  = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  name_prefix  = local.common_vars.locals.name_prefix
  account_info = local.common_vars.locals.account_info
  account_ids  = local.common_vars.locals.account_ids

  # Automatically load account-level variables
  account_vars         = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  account_name         = local.account_vars.locals.account_name
  account_id           = local.account_ids[local.account_name]
  state_bucket_pattern = local.account_vars.locals.state_bucket_pattern

  # Automatically load region-level variables
  region_vars = read_terragrunt_config(find_in_parent_folders("region.hcl"))
  aws_region  = local.region_vars.locals.aws_region

  # A local for convenient access to the security account root ARN.
  security_account_root_arn = "arn:aws:iam::${local.account_ids.security}:root"

  # The following locals are used for constructing multi region provider configurations for the underlying module.
  multi_region_vars = read_terragrunt_config(find_in_parent_folders("multi_region_common.hcl"))
  opt_in_regions    = local.multi_region_vars.locals.opt_in_regions

  # A local for convenient access to the macie variables
  macie_bucket_name  = lower("${local.common_vars.locals.macie_bucket_name_prefix}-${local.account_name}")
  macie_kms_key_name = local.common_vars.locals.macie_kms_key_name

  # Define a local for the config for KMS keys to create so that they can be merged in downstream without deep merge.
  base_kms_keys = {
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

  # This should contain an incoming webhook URL for the Slack channel #cis-audit
  # This secret lives in the shared account and is setup for cross account access so that every account can
  # stream the CIS alarms to Slack.
  slack_webhook_url_secrets_manager_arn = "arn:aws:secretsmanager:{{ .DefaultRegion }}:${local.account_ids.shared}:secret:SlackWebhookURLForCISAudit-yybOoL"
}

# Macie throws an error when initially creating classification jobs for the first time in an account due to the fact that the service linked role
# has not yet propagated. This is a retryable error, so we configure the retryable_errors variable to match the error message and then configure
# the retry_max_attempts and retry_sleep_interval_sec variables to retry the operation until it succeeds.
retryable_errors = [
  "(?s).*creating Macie ClassificationJob: ValidationException: Macie can't create the job right now. The Macie service-linked role for your account hasn't finished propagating. Try again in a few minutes.*"
]
retry_max_attempts       = 10
retry_sleep_interval_sec = 60

# ---------------------------------------------------------------------------------------------------------------------
# MODULE PARAMETERS
# These are the variables we have to pass in to use the module specified in the terragrunt configuration above.
# This defines the parameters that are common across all environments.
# ---------------------------------------------------------------------------------------------------------------------
inputs = {
  name_prefix = local.name_prefix

  iam_password_policy_hard_expiry             = false
  iam_password_policy_minimum_password_length = 16
  iam_password_policy_max_password_age        = 30


  ##################################
  # Cross-account IAM role permissions
  ##################################

  # By granting access to the root ARN of the Security account in each of the roles below,
  # we allow administrators to further delegate access to other IAM entities

  allow_read_only_access_from_other_account_arns = [local.security_account_root_arn]
  allow_support_access_from_other_account_arns   = [local.security_account_root_arn]


  ##################################
  # Multi region config
  ##################################

  # Configure opt in regions for each multi region service based on locally configured setting.
  guardduty_opt_in_regions           = local.opt_in_regions
  kms_cmk_opt_in_regions             = local.opt_in_regions
  iam_access_analyzer_opt_in_regions = local.opt_in_regions
  ebs_opt_in_regions                 = local.opt_in_regions
  security_hub_opt_in_regions        = local.opt_in_regions
  macie_opt_in_regions               = local.opt_in_regions

  ##################################
  # CONFIGURATION FOR CIS
  ##################################

  kms_customer_master_keys = local.base_kms_keys

  # Configure Amazon Macie
  create_macie_bucket  = true
  macie_bucket_name    = local.macie_bucket_name
  macie_create_kms_key = true
  macie_kms_key_name   = local.macie_kms_key_name
  macie_kms_key_users  = ["arn:aws:iam::${local.account_ids[local.account_name]}:root"]
  macie_opt_in_regions = local.opt_in_regions
  macie_buckets_to_analyze = {
    (local.aws_region) = [],
  }

  # Configure SecurityHub
  # We rely on Steampipe for the continuous CIS checks, so disable the SecurityHub built in checks.
  security_hub_enable_cis_check = false

  # Disable reserved concurrent executions. This is defaulted to 1 in the module for thread safety,
  # however, new accounts do not have enough capacity to set this to 1, so we disable it for initial deployment
  # If you have issues with concurrent IAM certificate access, you can set this to 1.
  reserved_concurrent_executions = -1
}
