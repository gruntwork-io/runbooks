# ---------------------------------------------------------------------------------------------------------------------
# OPENCLAW EC2 DEPLOYMENT
# Self-contained Terragrunt configuration that deploys OpenClaw on an EC2 instance
# with Tailscale for secure remote access. No external dependencies required.
# ---------------------------------------------------------------------------------------------------------------------

terraform {
  source = "${get_terragrunt_dir()}/modules/openclaw-ec2"
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
          Environment = "{{ .inputs.Environment }}"
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
  instance_name = "{{ .inputs.InstanceName }}-{{ .inputs.Environment }}"
  instance_type = "{{ .inputs.InstanceType }}"
  volume_size   = {{ .inputs.VolumeSize }}
  key_pair_name = "{{ .inputs.KeyPairName }}"

  allowed_ssh_cidr   = "{{ .inputs.AllowedSshCidr }}"
  tailscale_auth_key = "{{ .inputs.TailscaleAuthKey }}"

  openclaw_version = "{{ .inputs.OpenClawVersion }}"
  gateway_port     = {{ .inputs.GatewayPort }}

  tags = {
    Environment = "{{ .inputs.Environment }}"
    Name        = "{{ .inputs.InstanceName }}-{{ .inputs.Environment }}"
  }
}
