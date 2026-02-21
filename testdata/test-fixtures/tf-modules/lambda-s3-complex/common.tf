variable "environment" {
  type        = string
  description = "Deployment environment"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod"
  }
}

variable "project_name" {
  type        = string
  description = "Project name"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to all resources"
}

variable "notification_config" {
  type = object({
    email         = string
    slack_webhook = optional(string)
  })
  description = "Notification configuration"
}

variable "priority_order" {
  type        = tuple([string, number])
  description = "Priority order as name and numeric priority"
}

variable "enable_monitoring" {
  type        = bool
  default     = true
  description = "Enable CloudWatch monitoring"
  sensitive   = true
}
