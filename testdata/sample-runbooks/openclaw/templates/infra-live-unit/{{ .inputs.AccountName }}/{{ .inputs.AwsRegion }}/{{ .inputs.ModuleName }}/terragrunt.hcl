# ---------------------------------------------------------------------------------------------------------------------
# OPENCLAW EC2 DEPLOYMENT
# Terragrunt configuration that deploys OpenClaw on an EC2 instance with Tailscale for secure
# remote access.
# ---------------------------------------------------------------------------------------------------------------------

terraform {
  source = "git::{{ .inputs.CatalogRepoUrl }}.git//modules/{{ .inputs.ModuleName }}?ref={{ .inputs.ReleaseTag }}"
}
{{- if eq .outputs.check_root_hcl.has_root_hcl "true" }}

# ---------------------------------------------------------------------------------------------------------------------
# INCLUDE ROOT CONFIGURATION
# Inherit provider, backend, and catalog settings from root.hcl.
# ---------------------------------------------------------------------------------------------------------------------

include "root" {
  path   = find_in_parent_folders("root.hcl")
  expose = true
}
{{- else }}

# ---------------------------------------------------------------------------------------------------------------------
# PROVIDER CONFIGURATION
# Generate the AWS provider configuration automatically.
# ---------------------------------------------------------------------------------------------------------------------

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    provider "aws" {
      region = "{{ .inputs.AwsRegion }}"

      default_tags {
        tags = {
          ManagedBy   = "terragrunt"
          Application = "openclaw"
        }
      }
    }
  EOF
}

# ---------------------------------------------------------------------------------------------------------------------
# BACKEND CONFIGURATION
# Use a local backend for simplicity. For team use, switch to an S3 backend.
# ---------------------------------------------------------------------------------------------------------------------

generate "backend" {
  path      = "backend.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    terraform {
      backend "local" {
        path = "terraform.tfstate"
      }
    }
  EOF
}
{{- end }}

# ---------------------------------------------------------------------------------------------------------------------
# MODULE INPUTS
# These are the variables passed to the openclaw-ec2 module.
# ---------------------------------------------------------------------------------------------------------------------

inputs = {
  instance_name = "{{ .inputs.InstanceName }}"
  instance_type = "{{ .inputs.InstanceType }}"
  volume_size   = {{ .inputs.VolumeSize }}
  tailscale_auth_key = get_env("TAILSCALE_AUTH_KEY")

  openclaw_version = "{{ .inputs.OpenClawVersion }}"
  gateway_port     = {{ .inputs.GatewayPort }}

  tags = {
    Name = "{{ .inputs.InstanceName }}"
  }
}
