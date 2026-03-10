locals {
  account_name         = "shared"
  state_bucket_pattern = lower("{{ .inputs.OrgNamePrefix }}-${local.account_name}-*-tf-state")
}
