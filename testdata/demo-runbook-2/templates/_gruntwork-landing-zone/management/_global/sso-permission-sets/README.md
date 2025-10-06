# SSO Guide

We've created a few example Permission Sets for AWS Identity Center in this folder.
You can use these as an example to create your own using either AWS Managed Policies or
Inline Policies defined as json files.

You will need to create your own associations between Permission Sets and Groups.
For most Identity Providers, this happens within the Identity Provider rather than in AWS and changes
are synchronized automatically.

> **_NOTE_:**
> When using Google as your Identity Provider, you must define the groups and group membership yourself.
> We provide a sso-groups module for this purpose: <https://www.github.com/gruntwork-io/terraform-aws-control-tower>

## Example Usage

```hcl
# /management/_global/sso-groups/terragrunt.hcl

terraform {
  source = "git@github.com:gruntwork-io/terraform-aws-control-tower.git//modules/aws-sso/sso-groups?ref=v0.7.5"
}

dependency "a_permission_set" {
  config_path = "../sso-permission-sets/a-permission-set"
}

include "root" {
  path = find_in_parent_folders("root.hcl")
}

locals {
  common_vars = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  account_ids = local.common_vars.locals.account_ids

  # Marketplace access
  a_group = [
    "someone@acme.com"
  ]
}

inputs = {
  group_to_accounts_and_permissions = {
    "A Mapping" = {
      users               = local.a_group
      account_id          = local.account_ids.some_account
      permission_set_arn  = dependency.a_permission_set.outputs.arn
      permission_set_name = dependency.a_permission_set.outputs.name
    }
  }
}
```
