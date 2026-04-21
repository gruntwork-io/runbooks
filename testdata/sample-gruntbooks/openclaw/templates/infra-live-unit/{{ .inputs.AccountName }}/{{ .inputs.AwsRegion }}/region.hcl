# Set common variables for the region. This is automatically pulled in in the root root.hcl configuration to
# configure the remote state bucket and is accessible as inputs in child units.
locals {
  aws_region = "{{ .inputs.AwsRegion }}"
}
