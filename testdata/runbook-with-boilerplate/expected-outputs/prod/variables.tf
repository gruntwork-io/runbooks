# Variables for Lambda Function URL Configuration
# These variables are populated from the boilerplate.yml configuration

variable "account_name" {
  description = "Name for the AWS account"
  type        = string
  default     = "Production Account"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"
  validation {
    condition = contains(["dev", "stage", "prod"], var.environment)
    error_message = "Environment must be one of: dev, stage, prod."
  }
}

variable "enable_logging" {
  description = "Enable CloudWatch logging"
  type        = bool
  default     = false
}

variable "instance_count" {
  description = "Number of instances to deploy"
  type        = number
  default     = 5
  validation {
    condition     = var.instance_count > 0 && var.instance_count <= 100
    error_message = "Instance count must be between 1 and 100."
  }
}

variable "tags" {
  description = "Additional tags to apply"
  type        = map(string)
  default = {
    
    "Environment" = "production"
    
    "Team" = "Platform"
    
  }
}

variable "allowed_ips" {
  description = "List of allowed IP addresses"
  type        = list(string)
  default     = [
    
  ]
}

# Additional computed variables
locals {
  function_name = "my-lambda-function-${var.environment}"
  log_retention = var.environment == "prod" ? 30 : 14
}
