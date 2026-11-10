variable "name" {
  type        = string
  description = "Name of the thing."
  validation {
    condition     = length(var.name) >= 3 && length(var.name) <= 20
    error_message = "Use 3 to 20 characters."
  }
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*\\d$", var.name))
    error_message = "Start with a letter and end with a digit."
  }
}

variable "tier" {
  type    = string
  default = "standard"
  validation {
    condition     = contains(["basic", "standard", "premium"], var.tier)
    error_message = "Use basic, standard, or premium."
  }
}

variable "access" {
  type        = map(string)
  description = "Who can do what."
  default     = {}
}

variable "owner" {
  type        = string
  description = "Who owns it."
  validation {
    condition     = var.owner != ""
    error_message = "Name an owner."
  }
  validation {
    condition     = endswith(var.owner, "@example.com")
    error_message = "Use an example.com address."
  }
}

variable "config" {
  type      = object({ size = number, labels = optional(map(string), {}) })
  default   = null
  sensitive = true
}
