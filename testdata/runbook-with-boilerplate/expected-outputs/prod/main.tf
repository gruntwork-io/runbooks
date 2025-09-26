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

  cors {
    allow_credentials = false
    allow_origins     = ["*"]
    allow_methods     = ["*"]
    allow_headers     = ["date", "keep-alive"]
    expose_headers    = ["date", "keep-alive"]
    max_age          = 86400
  }
}

# CloudWatch Log Group (conditional based on EnableLogging)


# Auto Scaling Configuration
resource "aws_appautoscaling_target" "lambda_target" {
  max_capacity       = 5
  min_capacity       = 1
  resource_id        = "function:my-lambda-function"
  scalable_dimension = "lambda:function:provisioned-concurrency"
  service_namespace  = "lambda"
}

# Security Group for Lambda (if AllowedIPs is provided)

# Apply tags to all resources
resource "aws_lambda_function_url" "function_url_tagged" {
  function_name      = "my-lambda-function"
  authorization_type = "NONE"
  
  tags = local.common_tags
}
