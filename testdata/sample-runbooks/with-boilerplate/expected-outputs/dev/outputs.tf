# Outputs for Lambda Function URL Configuration

output "function_url" {
  description = "The HTTP URL endpoint for the Lambda function"
  value       = aws_lambda_function_url.function_url.function_url
}

output "function_arn" {
  description = "The Amazon Resource Name (ARN) of the function"
  value       = aws_lambda_function_url.function_url.function_arn
}

output "function_url_id" {
  description = "The generated ID for the endpoint"
  value       = aws_lambda_function_url.function_url.function_url_id
}


output "log_group_name" {
  description = "The name of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.lambda_logs.name
}

output "log_group_arn" {
  description = "The ARN of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.lambda_logs.arn
}


output "account_name" {
  description = "The AWS account name"
  value       = "Test Account"
}

output "environment" {
  description = "The deployment environment"
  value       = "dev"
}

output "instance_count" {
  description = "The configured instance count"
  value       = 2
}


output "allowed_ips" {
  description = "List of allowed IP addresses"
  value       = [
    
    "10.0.0.0/8",
    
    "192.168.1.0/24",
    
  ]
}


output "tags" {
  description = "Applied tags"
  value = {
    
    "Owner" = "Test User"
    
    "Project" = "Test Project"
    
  }
}
