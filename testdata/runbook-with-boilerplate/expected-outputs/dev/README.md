# Lambda Function URL Terraform Template

This template creates a Lambda Function URL with configurable options based on the boilerplate variables.

## Configuration

The following variables are configured from the boilerplate.yml:

- **AccountName**: `Test Account` - Name for the AWS account
- **Environment**: `dev` - Deployment environment (dev/stage/prod)
- **EnableLogging**: `true` - Enable CloudWatch logging
- **InstanceCount**: `2` - Number of instances to deploy
- **Tags**: `map[Owner:Test User Project:Test Project]` - Additional tags to apply
- **AllowedIPs**: `[10.0.0.0/8 192.168.1.0/24]` - List of allowed IP addresses

## Resources Created

1. **Lambda Function URL** - HTTP(S) endpoint for the Lambda function
2. **CloudWatch Log Group** - (Conditional) If EnableLogging is true
3. **Auto Scaling Target** - Configures scaling based on InstanceCount
4. **Security Group** - (Conditional) If AllowedIPs are provided

## Usage

1. Initialize Terraform:
   ```bash
   terraform init
   ```

2. Review the plan:
   ```bash
   terraform plan
   ```

3. Apply the configuration:
   ```bash
   terraform apply
   ```

4. Get the function URL:
   ```bash
   terraform output function_url
   ```

## Outputs

- `function_url` - The HTTP URL endpoint
- `function_arn` - The function ARN
- `function_url_id` - The endpoint ID
- `log_group_name` - (If logging enabled) CloudWatch log group name
- `account_name` - The configured account name
- `environment` - The deployment environment
- `instance_count` - The configured instance count
- `allowed_ips` - (If provided) List of allowed IPs
- `tags` - Applied tags

## Environment-Specific Behavior

- **Production**: 30-day log retention
- **Non-Production**: 14-day log retention
- **Development**: Minimal logging and scaling
