locals {
  account_name         = "security"
  state_bucket_pattern = lower("{{ .inputs.OrgNamePrefix }}-${local.account_name}-*-tf-state")
}
