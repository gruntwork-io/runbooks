# Lambda Function URL Configuration
# Generated for Production Account in prod environment

terraform {
  required_version = ">= 1.0"
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

# Tags for all resources
locals {
  common_tags = {
    Account     = "Production Account"
    Environment = "prod"
    
    Environment = "production"
    
    Team = "Platform"
    
  }
}

# Lambda Function URL
resource "aws_lambda_function_url" "function_url" {
  function_name      = "my-lambda-function"
  authorization_type = "NONE"
}

# CloudWatch Log Group (conditional based on EnableLogging)


# Auto Scaling Configuration
resource "aws_appautoscaling_target" "lambda_target" {
  max_capacity       = 5
  min_capacity       = 1
  resource_id        = "function:my-lambda-function"
  scalable_dimension = "lambda:function:provisioned-concurrency"
  service_namespace  = "lambda"

  tags = local.common_tags
}

# Security Group for Lambda (if AllowedIPs is provided)

