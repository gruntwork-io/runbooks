variable "instance_name" {
  type        = string
  description = "Name of the compute instance"
}

variable "instance_type" {
  type        = string
  default     = "t3.micro"
  description = "EC2 instance type"
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
