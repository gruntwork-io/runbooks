variable "bucket_name" {
  type        = string
  description = "Name of the S3 bucket"
}

variable "bucket_versioning" {
  type        = bool
  default     = true
  description = "Enable bucket versioning"
}

variable "bucket_lifecycle_rules" {
  type = list(object({
    id      = string
    enabled = bool
    prefix  = string
    expiration_days = number
  }))
  default     = []
  description = "Lifecycle rules for the bucket"
}
