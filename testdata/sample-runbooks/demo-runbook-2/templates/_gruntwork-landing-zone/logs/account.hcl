locals {
  account_name         = "logs"
  state_bucket_pattern = lower("{{ .OrgNamePrefix }}-${local.account_name}-*-tf-state")
}
