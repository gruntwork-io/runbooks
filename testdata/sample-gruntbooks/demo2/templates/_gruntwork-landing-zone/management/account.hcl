locals {
  account_name         = "management"
  state_bucket_pattern = lower("{{ .inputs.OrgNamePrefix }}-${local.account_name}-*-tf-state")
}
