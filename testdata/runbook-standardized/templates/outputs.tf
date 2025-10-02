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

{{ if .EnableLogging }}
output "log_group_name" {
  description = "The name of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.lambda_logs.name
}

output "log_group_arn" {
  description = "The ARN of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.lambda_logs.arn
}
{{ end }}

output "account_name" {
  description = "The AWS account name"
  value       = "{{ .AccountName }}"
}

output "environment" {
  description = "The deployment environment"
  value       = "{{ .Environment }}"
}

output "instance_count" {
  description = "The configured instance count"
  value       = {{ .InstanceCount }}
}

{{ if .AllowedIPs }}
output "allowed_ips" {
  description = "List of allowed IP addresses"
  value       = [
    {{ range .AllowedIPs }}
    "{{ . }}",
    {{ end }}
  ]
}
{{ end }}

output "tags" {
  description = "Applied tags"
  value = {
    {{ range $key, $value := .Tags }}
    "{{ $key }}" = "{{ $value }}"
    {{ end }}
  }
}
