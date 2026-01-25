# Lambda Function URL Configuration
# Generated for Test Account in dev environment

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
    Account     = "Test Account"
    Environment = "dev"
    
    Owner = "Test User"
    
    Project = "Test Project"
    
  }
}

# Lambda Function URL
resource "aws_lambda_function_url" "function_url" {
  function_name      = "my-lambda-function"
  authorization_type = "NONE"
}

# CloudWatch Log Group (conditional based on EnableLogging)

resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/my-lambda-function"
  retention_in_days = 14
}


# Auto Scaling Configuration
resource "aws_appautoscaling_target" "lambda_target" {
  max_capacity       = 2
  min_capacity       = 1
  resource_id        = "function:my-lambda-function"
  scalable_dimension = "lambda:function:provisioned-concurrency"
  service_namespace  = "lambda"

  tags = local.common_tags
}

# Security Group for Lambda (if AllowedIPs is provided)

resource "aws_security_group" "lambda_sg" {
  name_prefix = "lambda-function-url-"
  
  
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
  
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["192.168.1.0/24"]
  }
  

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "lambda-function-url-sg"
  }
}

