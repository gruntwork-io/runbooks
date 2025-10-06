locals {
  account_name         = "management"
  state_bucket_pattern = lower("{{ .OrgNamePrefix }}-${local.account_name}-*-tf-state")
}
