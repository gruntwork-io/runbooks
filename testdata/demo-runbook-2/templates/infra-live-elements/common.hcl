locals {
  name_prefix    = "{{ .OrgNamePrefix }}"
  default_region = "{{ .DefaultRegion }}"
  account_info   = yamldecode(file("accounts.yml"))
  account_ids = {
    for account_name, info in local.account_info :
    account_name => info.id
  }

  {{- if .AddAdditionalCommonVariables }}
  # The name of the S3 bucket in the Logs account where AWS Config will report its findings.
  config_s3_bucket_name = "${local.name_prefix}-config-logs"

  # The name of the S3 bucket in the Logs account where AWS CloudTrail will report its findings.
  cloudtrail_s3_bucket_name = "${local.name_prefix}-cloudtrail-logs"

  # The name of the S3 bucket where Macie will store sensitive data discovery results.
  macie_bucket_name_prefix = "${local.name_prefix}-macie-results"

  # The name of the KMS key that the above bucket will be encrypted with.
  macie_kms_key_name = "${local.name_prefix}-macie"

  # List of known static CIDR blocks for the organization. Administrative access (e.g., VPN, SSH,
  # etc) will be limited to these source CIDRs.
  vpn_ip_allow_list = ["0.0.0.0/0"]
  ssh_ip_allow_list = ["0.0.0.0/0"]

  # IAM configurations for cross account ssh-grunt setup.
#  ssh_grunt_users_group      = "ssh-grunt-users"
#  ssh_grunt_sudo_users_group = "ssh-grunt-sudo-users"
#  allow_ssh_grunt_role       = "arn:aws:iam::${local.account_ids.security}:role/allow-ssh-grunt-access-from-other-accounts"

  # Map of domain names to hosted zones to use
#  hosted_zone_id_map = {
#    "your-domain.com" = "Z1234567890124"
#  }
  {{- end }}

  # Tags
  default_tags = yamldecode(file("tags.yml"))
}
