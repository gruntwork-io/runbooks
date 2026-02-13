variable "vpc_id" {
  type        = string
  description = "VPC ID for the Lambda function"
}

variable "subnet_ids" {
  type        = list(string)
  description = "Subnet IDs for the Lambda function"
}

variable "security_group_ids" {
  type        = set(string)
  description = "Security group IDs"
}
