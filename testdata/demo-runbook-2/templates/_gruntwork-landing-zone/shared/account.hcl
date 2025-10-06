locals {
  account_name         = "shared"
  state_bucket_pattern = lower("{{ .OrgNamePrefix }}-${local.account_name}-*-tf-state")
}
