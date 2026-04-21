# ---------------------------------------------------------------------------------------------------------------------
# TERRAGRUNT CONFIGURATION
# This is the configuration for Terragrunt, an orchestrator for OpenTofu that supports locking and enforces best
# practices: https://github.com/gruntwork-io/terragrunt
# ---------------------------------------------------------------------------------------------------------------------

terraform {
  source = "git@github.com:gruntwork-io/terraform-aws-control-tower.git//modules/landingzone/control-tower-multi-account-factory?ref=v0.7.5"

  # Service Catalog can get very upset if more than 5 resources are updated at once.
  # See https://github.com/gruntwork-io/terraform-aws-control-tower/tree/main/modules/landingzone/control-tower-account-factory#troubleshooting-tips for more details
  extra_arguments "restrict_parallelism" {
    commands = [
      "apply",
    ]

    arguments = [
      "-parallelism=5",
    ]
  }
}

# Include the root terragrunt configuration, which has settings common across all environments & components.
include "root" {
  path = find_in_parent_folders("root.hcl")
}

# Control Tower has a limit on concurrent operations: e.g., you can create up to 5 accounts concurrently; other operations have a limit of 1.
# If you exceed the limit, you get an error like this:
#
# Error: waiting for Service Catalog Provisioned Product (xx-xxxxxxxxxxxxx) create: ResourceInUseException  Account Factory cannot complete an operation on this account, because another AWS Control Tower operation is in progress. Try again later.
#
# Here, we add an automatic retry in case of concurrency errors, as most of these errors can be resolved by just waiting for the other
# operation to complete and trying again.
retryable_errors = [
  "(?s).*ResourceInUseException.*Account Factory cannot complete an operation on this account, because another AWS Control Tower operation is in progress.*"
]
# Control Tower operations can take a long time, so we retry for an hour: 6 retries with 10 minutes between retries.
retry_max_attempts       = 6
retry_sleep_interval_sec = 600

inputs = {
  account_requests_folder = "${get_repo_root()}/_new-account-requests"
  accounts_yaml_path      = "${get_repo_root()}/accounts.yml"
}
