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



output "account_name" {
  description = "The AWS account name"
  value       = "Production Account"
}

output "environment" {
  description = "The deployment environment"
  value       = "prod"
}

output "instance_count" {
  description = "The configured instance count"
  value       = 5
}



output "tags" {
  description = "Applied tags"
  value = {
    
    "Environment" = "production"
    
    "Team" = "Platform"
    
  }
}
