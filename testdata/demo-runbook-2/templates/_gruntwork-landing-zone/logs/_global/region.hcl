# Even for global resources, you still need an AWS region for OpenTofu to talk to. This variable is automatically
# pulled in using the extra_arguments setting in the root terraform.tfvars file's Terragrunt configuration.
locals {
  aws_region = "{{ .DefaultRegion }}"
}
