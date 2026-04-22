# Set account-wide variables. These are automatically pulled in to configure the remote state bucket in the root
# root.hcl configuration.
locals {
  account_name   = "{{ .inputs.AccountName }}"
  aws_account_id = "{{ .outputs.detect_account.account_id }}"
}
