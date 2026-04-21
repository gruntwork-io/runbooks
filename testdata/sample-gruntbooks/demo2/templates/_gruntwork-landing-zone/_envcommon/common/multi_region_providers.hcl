# ---------------------------------------------------------------------------------------------------------------------
# COMMON TERRAGRUNT CONFIGURATION FOR MULTI REGION
# ---------------------------------------------------------------------------------------------------------------------

locals {
  # The following locals are used for constructing multi region provider configurations for the underlying module.
  multi_region_vars = read_terragrunt_config(find_in_parent_folders("multi_region_common.hcl"))
  all_aws_regions   = local.multi_region_vars.locals.all_aws_regions
  opt_in_regions    = local.multi_region_vars.locals.opt_in_regions

  # Tags
  # Automatically load common variables shared across all accounts
  common_vars = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  # Load an overrides.yml file in any Terragrunt folder, or fallback to {} if none is found
  override_tags = try(yamldecode(file("${get_terragrunt_dir()}/tags.yml")), {})
  # The final tags to apply to all resources are a merge between the default tags and override tags
  tags = merge(local.common_vars.locals.default_tags, local.override_tags)
}

# ---------------------------------------------------------------------------------------------------------------------
# CONFIGURE A PROVIDER FOR EACH AWS REGION
# To deploy a multi-region module, we have to configure a provider with a unique alias for each of the regions AWS
# supports and pass all these providers to the multi-region module in a provider = { ... } block. You MUST create a
# provider block for EVERY one of these AWS regions, but you should specify the ones to use and authenticate to (the
# ones actually enabled in your AWS account) using opt_in_regions.
# ---------------------------------------------------------------------------------------------------------------------

generate "providers" {
  path      = "providers.tf"
  if_exists = "overwrite"
  contents  = <<EOF
provider "aws" {
  region = "us-east-1"
  alias  = "default"
  # tags
  default_tags {
    tags = ${jsonencode(local.tags)}
  }
}

%{for region in local.all_aws_regions}
provider "aws" {
  region = "${region}"
  alias  = "${replace(region, "-", "_")}"
  # Skip credential validation and account ID retrieval for disabled or restricted regions
  skip_credentials_validation = ${contains(coalesce(local.opt_in_regions, []), region) ? "false" : "true"}
  skip_requesting_account_id  = ${contains(coalesce(local.opt_in_regions, []), region) ? "false" : "true"}
  # tags
  default_tags {
    tags = ${jsonencode(local.tags)}
  }
}
%{endfor}
EOF
}
