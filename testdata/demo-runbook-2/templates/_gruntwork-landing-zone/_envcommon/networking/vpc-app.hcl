# ---------------------------------------------------------------------------------------------------------------------
# COMMON TERRAGRUNT CONFIGURATION
# This is the common component configuration for networking/vpc-mgmt. The common variables for each environment to
# deploy networking/vpc-mgmt are defined here. This configuration will be merged into the environment configuration via
# an include block.
# ---------------------------------------------------------------------------------------------------------------------

# ---------------------------------------------------------------------------------------------------------------------
# Locals are named constants that are reusable within the configuration.
# ---------------------------------------------------------------------------------------------------------------------

locals {
  # Automatically load common variables shared across all accounts
  common_vars = read_terragrunt_config(find_in_parent_folders("common.hcl"))

  # Automatically load account-level variables
  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  account_name = local.account_vars.locals.account_name
  account_ids  = local.common_vars.locals.account_ids
  account_id   = local.account_ids[local.account_name]

  # Automatically load region-level variables
  region_vars = read_terragrunt_config(find_in_parent_folders("region.hcl"))
  region      = local.region_vars.locals.aws_region
}

# ---------------------------------------------------------------------------------------------------------------------
# MODULE PARAMETERS
# These are the variables we have to pass in to use the module specified in the terragrunt configuration above
# ---------------------------------------------------------------------------------------------------------------------

inputs = {
  vpc_name                                  = local.account_name
  aws_region                                = local.region
  num_nat_gateways                          = 1
  allow_private_persistence_internet_access = true

  kms_key_user_iam_arns = ["arn:aws:iam::${local.account_id}:root"]
}
