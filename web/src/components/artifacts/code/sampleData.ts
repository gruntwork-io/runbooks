import type { CodeFileData } from './FileTree';

// Sample data structure for demonstration
export const sampleCodeFileData: CodeFileData[] = [
  {
    id: "terraform",
    name: "terraform",
    type: "folder",
    children: [
      {
        id: "main.tf",
        name: "main.tf",
        type: "file",
        filePath: "terraform/main.tf",
        code: `# Simple OpenTofu configuration
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-west-2"
}

# Create a VPC
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = {
    Name = "main-vpc"
  }
}

# Create a security group
resource "aws_security_group" "web" {
  name_prefix = "web-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

output "vpc_id" {
  value = aws_vpc.main.id
}`,
        language: "hcl"
      },
      {
        id: "vars.tf",
        name: "vars.tf",
        type: "file",
        filePath: "terraform/vars.tf",
        code: `variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-west-2"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "dev"
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}`,
        language: "hcl"
      }
    ]
  },
  {
    id: "scripts",
    name: "scripts",
    type: "folder",
    children: [
      {
        id: "deploy.sh",
        name: "deploy.sh",
        type: "file",
        filePath: "scripts/deploy.sh",
        code: `#!/bin/bash

# Deployment script
set -e

echo "Starting deployment..."

# Initialize Terraform
terraform init

# Plan the deployment
terraform plan -out=tfplan

# Apply the plan
terraform apply tfplan

echo "Deployment completed successfully!"`,
        language: "bash"
      }
    ]
  },
  {
    id: "README.md",
    name: "README.md",
    type: "file",
    filePath: "README.md",
    code: `# Project Documentation

This project contains Terraform configurations for deploying AWS infrastructure.

## Prerequisites

- Terraform >= 1.0
- AWS CLI configured
- Appropriate AWS permissions

## Usage

1. Clone the repository
2. Navigate to the terraform directory
3. Run \`terraform init\`
4. Run \`terraform plan\`
5. Run \`terraform apply\`

## Structure

- \`terraform/\` - Terraform configuration files
- \`scripts/\` - Deployment and utility scripts`,
    language: "markdown"
  }
];
