# ---------------------------------------------------------------------------------------------------------------------
# OPENCLAW EC2 DEPLOYMENT
# Terragrunt configuration that deploys OpenClaw on an EC2 instance with Tailscale for secure
# remote access.
# ---------------------------------------------------------------------------------------------------------------------

terraform {
  source = "git::{{ .inputs.CatalogRepoUrl }}.git//modules/{{ .inputs.ModuleName }}?ref={{ .inputs.ReleaseTag }}"
}

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

# ---------------------------------------------------------------------------------------------------------------------
# MODULE INPUTS
# These are the variables passed to the openclaw-ec2 module.
# ---------------------------------------------------------------------------------------------------------------------

inputs = {
  instance_name = "{{ .inputs.InstanceName }}"
  instance_type = "{{ .inputs.InstanceType }}"
  volume_size   = {{ .inputs.VolumeSize }}
  allowed_ssh_cidr   = "{{ .inputs.AllowedSshCidr }}"
  tailscale_auth_key = get_env("TAILSCALE_AUTH_KEY")

  openclaw_version = "{{ .inputs.OpenClawVersion }}"
  gateway_port     = {{ .inputs.GatewayPort }}

  tags = {
    Name = "{{ .inputs.InstanceName }}"
  }
}
