variable "bucket_name" {
  type        = string
  description = "Name of the S3 bucket"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.bucket_name))
    error_message = "Must be lowercase alphanumeric with dots and hyphens."
  }
}

variable "versioning_enabled" {
  type        = bool
  default     = true
  description = "Enable versioning"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply"
}

# @runbooks:group "Lifecycle"
variable "expiration_days" {
  type        = number
  default     = 0
  description = "Days before expiration"
}

# @runbooks:group "Lifecycle"
variable "transition_to_glacier_days" {
  type        = number
  default     = 0
  description = "Days before Glacier transition"
}
