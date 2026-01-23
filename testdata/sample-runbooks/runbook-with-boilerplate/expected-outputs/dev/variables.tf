# Variables for Lambda Function URL Configuration
# These variables are populated from the boilerplate.yml configuration

variable "account_name" {
  description = "Name for the AWS account"
  type        = string
  default     = "Test Account"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "dev"
  validation {
    condition = contains(["dev", "stage", "prod"], var.environment)
    error_message = "Environment must be one of: dev, stage, prod."
  }
}

variable "enable_logging" {
  description = "Enable CloudWatch logging"
  type        = bool
  default     = true
}

variable "instance_count" {
  description = "Number of instances to deploy"
  type        = number
  default     = 2
  validation {
    condition     = var.instance_count > 0 && var.instance_count <= 100
    error_message = "Instance count must be between 1 and 100."
  }
}

variable "tags" {
  description = "Additional tags to apply"
  type        = map(string)
  default = {
    
    "Owner" = "Test User"
    
    "Project" = "Test Project"
    
  }
}

variable "allowed_ips" {
  description = "List of allowed IP addresses"
  type        = list(string)
  default     = [
    
    "10.0.0.0/8",
    
    "192.168.1.0/24",
    
  ]
}

# Additional computed variables
locals {
  function_name = "my-lambda-function-${var.environment}"
  log_retention = var.environment == "prod" ? 30 : 14
}
