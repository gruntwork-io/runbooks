# ---------------------------------------------------------------------------------------------------------------------
# OPENCLAW EC2 MODULE
# Deploys an EC2 instance running OpenClaw in Docker with Tailscale for secure access.
# Creates a dedicated VPC, subnet, security group, and Elastic IP.
# ---------------------------------------------------------------------------------------------------------------------

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = ">= 4.0"
    }
  }
}

# ---------------------------------------------------------------------------------------------------------------------
# DATA SOURCES
# Look up the latest Ubuntu 24.04 AMI for the target architecture.
# ---------------------------------------------------------------------------------------------------------------------

locals {
  # Determine architecture based on instance type prefix
  is_graviton = startswith(var.instance_type, "t4g") || startswith(var.instance_type, "c7g") || startswith(var.instance_type, "m7g")
  ami_arch    = local.is_graviton ? "arm64" : "amd64"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${local.ami_arch}-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

# ---------------------------------------------------------------------------------------------------------------------
# VPC AND NETWORKING
# Create a dedicated VPC with a public subnet for the OpenClaw instance.
# ---------------------------------------------------------------------------------------------------------------------

resource "aws_vpc" "openclaw" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, {
    Name = "${var.instance_name}-vpc"
  })
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.openclaw.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name = "${var.instance_name}-public"
  })
}

resource "aws_internet_gateway" "openclaw" {
  vpc_id = aws_vpc.openclaw.id

  tags = merge(var.tags, {
    Name = "${var.instance_name}-igw"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.openclaw.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.openclaw.id
  }

  tags = merge(var.tags, {
    Name = "${var.instance_name}-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------------------------------------------------
# SECURITY GROUP
# Allow SSH from the configured CIDR and all outbound traffic.
# OpenClaw port (18789) is NOT exposed publicly — access is via Tailscale.
# ---------------------------------------------------------------------------------------------------------------------

resource "aws_security_group" "openclaw" {
  name_prefix = "${var.instance_name}-"
  description = "Security group for OpenClaw EC2 instance"
  vpc_id      = aws_vpc.openclaw.id

  tags = merge(var.tags, {
    Name = "${var.instance_name}-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.openclaw.id
  description       = "SSH access"
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
  cidr_ipv4         = var.allowed_ssh_cidr
}

resource "aws_vpc_security_group_egress_rule" "all_outbound" {
  security_group_id = aws_security_group.openclaw.id
  description       = "Allow all outbound traffic"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------------------------------------------------------------------------------------------------------------------
# SSH KEY PAIR
# Auto-create an EC2 key pair so the user doesn't need to pre-create one.
# The private key is stored in Terraform state and exposed as a sensitive output.
# ---------------------------------------------------------------------------------------------------------------------

resource "tls_private_key" "openclaw" {
  algorithm = "ED25519"
}

resource "aws_key_pair" "openclaw" {
  key_name   = "${var.instance_name}-key"
  public_key = tls_private_key.openclaw.public_key_openssh

  tags = merge(var.tags, {
    Name = "${var.instance_name}-key"
  })
}

# ---------------------------------------------------------------------------------------------------------------------
# EC2 INSTANCE
# Launch the OpenClaw instance with Docker and Tailscale installed via user_data.
# ---------------------------------------------------------------------------------------------------------------------

resource "aws_instance" "openclaw" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = aws_key_pair.openclaw.key_name
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.openclaw.id]

  root_block_device {
    volume_size = var.volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    tailscale_auth_key = var.tailscale_auth_key
    openclaw_version   = var.openclaw_version
    gateway_port       = var.gateway_port
    instance_name      = var.instance_name
  })

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tags = merge(var.tags, {
    Name = var.instance_name
  })
}

# ---------------------------------------------------------------------------------------------------------------------
# ELASTIC IP
# Assign a stable public IP for SSH access.
# ---------------------------------------------------------------------------------------------------------------------

resource "aws_eip" "openclaw" {
  instance = aws_instance.openclaw.id
  domain   = "vpc"

  tags = merge(var.tags, {
    Name = "${var.instance_name}-eip"
  })
}
