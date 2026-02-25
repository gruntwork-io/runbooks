variable "vpc_id" {
  type        = string
  description = "VPC ID for the Lambda function"
  validation {
    condition     = can(regex("^vpc-[0-9a-f]{8,17}$", var.vpc_id))
    error_message = "VPC ID must match the format vpc-xxxxxxxxx (e.g. vpc-0a1b2c3d4e5f67890)"
  }
}

variable "subnet_ids" {
  type        = list(string)
  description = "Subnet IDs for the Lambda function"
}

variable "security_group_ids" {
  type        = set(string)
  description = "Security group IDs"
}

variable "description" {
  type        = string
  description = "Resource description"
  validation {
    condition     = length(var.description) >= 3 && length(var.description) <= 256
    error_message = "Description must be between 3 and 256 characters."
  }
}

variable "cidr_block" {
  type        = string
  description = "CIDR block for the VPC"
  validation {
    condition     = var.cidr_block != ""
    error_message = "CIDR block must not be empty."
  }
}

variable "max_connections" {
  type        = number
  description = "Maximum number of connections"
  default     = 100
  validation {
    condition     = var.max_connections >= 1 && var.max_connections <= 10000
    error_message = "Must be between 1 and 10000."
  }
}
