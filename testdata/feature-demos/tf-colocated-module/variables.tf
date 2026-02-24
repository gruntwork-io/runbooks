variable "instance_name" {
  type        = string
  description = "Name of the compute instance"
}

variable "instance_type" {
  type        = string
  default     = "t3.micro"
  description = "EC2 instance type"
  validation {
    condition     = contains(["t3.micro", "t3.small", "t3.medium", "t3.large"], var.instance_type)
    error_message = "Instance type must be one of: t3.micro, t3.small, t3.medium, t3.large"
  }
}

variable "enable_monitoring" {
  type        = bool
  default     = true
  description = "Enable detailed monitoring"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to all resources"
}
