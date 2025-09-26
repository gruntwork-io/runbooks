# Lambda Function URL Configuration
# Generated for {{ .AccountName }} in {{ .Environment }} environment

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
    Account     = "{{ .AccountName }}"
    Environment = "{{ .Environment }}"
    {{ range $key, $value := .Tags }}
    {{ $key }} = "{{ $value }}"
    {{ end }}
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
{{ if .EnableLogging }}
resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/my-lambda-function"
  retention_in_days = 14
}
{{ end }}

# Auto Scaling Configuration
resource "aws_appautoscaling_target" "lambda_target" {
  max_capacity       = {{ .InstanceCount }}
  min_capacity       = 1
  resource_id        = "function:my-lambda-function"
  scalable_dimension = "lambda:function:provisioned-concurrency"
  service_namespace  = "lambda"
}

# Security Group for Lambda (if AllowedIPs is provided)
{{ if .AllowedIPs }}
resource "aws_security_group" "lambda_sg" {
  name_prefix = "lambda-function-url-"
  
  {{ range .AllowedIPs }}
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["{{ . }}"]
  }
  {{ end }}

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
{{ end }}
# Apply tags to all resources
resource "aws_lambda_function_url" "function_url_tagged" {
  function_name      = "my-lambda-function"
  authorization_type = "NONE"
  
  tags = local.common_tags
}
