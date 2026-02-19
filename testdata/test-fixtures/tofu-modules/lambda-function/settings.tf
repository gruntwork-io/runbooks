# @group "Advanced Settings"
variable "memory_size" {
  type        = number
  default     = 128
  description = "Amount of memory in MB"
}

# @group "Advanced Settings"
variable "timeout" {
  type        = number
  default     = 30
  description = "Timeout in seconds"
}

# @group "Advanced Settings"
variable "reserved_concurrency" {
  type        = number
  default     = null
  description = "Reserved concurrent executions"
  nullable    = true
}
