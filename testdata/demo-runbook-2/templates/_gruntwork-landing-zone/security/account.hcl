locals {
  account_name         = "security"
  state_bucket_pattern = lower("{{ .OrgNamePrefix }}-${local.account_name}-*-tf-state")
}
