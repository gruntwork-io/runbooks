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
