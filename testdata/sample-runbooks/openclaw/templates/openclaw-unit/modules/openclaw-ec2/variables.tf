variable "instance_name" {
  type        = string
  description = "Name for the OpenClaw EC2 instance"
}

variable "instance_type" {
  type        = string
  default     = "t4g.medium"
  description = "EC2 instance type (Graviton t4g recommended for cost savings)"
  validation {
    condition     = contains(["t4g.small", "t4g.medium", "t3.small", "t3.medium"], var.instance_type)
    error_message = "Instance type must be one of: t4g.small, t4g.medium, t3.small, t3.medium"
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

variable "key_pair_name" {
  type        = string
  description = "Name of an existing EC2 key pair for SSH access"
}

variable "allowed_ssh_cidr" {
  type        = string
  default     = "0.0.0.0/0"
  description = "CIDR block allowed to SSH into the instance"
}

variable "tailscale_auth_key" {
  type        = string
  sensitive   = true
  description = "Tailscale pre-authentication key for joining the Tailnet"
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
