variable "instance_name" {
  type        = string
  description = "Name for the OpenClaw EC2 instance"
}

variable "instance_type" {
  type        = string
  default     = "t4g.medium"
  description = "EC2 instance type (Graviton t4g recommended for cost savings). t4g.medium (4GB RAM) is the minimum recommended for OpenClaw."
  validation {
    condition     = contains(["t4g.medium", "t4g.large", "t3.medium", "t3.large"], var.instance_type)
    error_message = "Instance type must be one of: t4g.medium, t4g.large, t3.medium, t3.large. OpenClaw requires at least 4GB RAM."
  }
}

variable "volume_size" {
  type        = number
  default     = 30
  description = "Root EBS volume size in GB"
  validation {
    condition     = var.volume_size >= 20
    error_message = "Volume size must be at least 20 GB for Docker images"
  }
}

variable "openclaw_version" {
  type        = string
  default     = "latest"
  description = "OpenClaw Docker image tag"
}

variable "gateway_port" {
  type        = number
  default     = 18789
  description = "Port for the OpenClaw gateway"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to all resources"
}
