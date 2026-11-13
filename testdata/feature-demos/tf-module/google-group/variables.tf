# Adapted from terraform-google-modules/terraform-google-group (Apache License 2.0, Copyright 2018 Google LLC).

variable "id" {
  description = "Email address of the group, such as aws-prod-root@example.com. It's also the group's ID."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.id))
    error_message = "Give the group's email address, such as aws-prod-root@example.com."
  }
}

variable "display_name" {
  description = "Name people see for the group. Empty uses the email address."
  type        = string
  nullable    = false
  default     = ""
}

variable "description" {
  description = "What the group is for."
  type        = string
  nullable    = false
  default     = ""
}

variable "domain" {
  description = "Primary domain of the Google Workspace or Cloud Identity organization to create the group in, such as example.com. Give domain, customer_id, or both."
  type        = string
  nullable    = false
  default     = ""
}

variable "customer_id" {
  description = "Customer ID of the organization to create the group in, such as C01abc23d. When both are given, customer_id names the organization."
  type        = string
  nullable    = false
  default     = ""
  validation {
    condition     = var.domain != "" || var.customer_id != ""
    error_message = "Give domain or customer_id."
  }
}

variable "owners" {
  description = "Email addresses of the group's owners: users, groups, or service accounts that already exist."
  type        = list(string)
  nullable    = false
  default     = []
}

variable "managers" {
  description = "Email addresses of the group's managers: users, groups, or service accounts that already exist."
  type        = list(string)
  nullable    = false
  default     = []
}

variable "members" {
  description = "Email addresses of the group's members: users, groups, or service accounts that already exist. Owners and managers are members already."
  type        = list(string)
  nullable    = false
  default     = []
}

variable "types" {
  description = "Kinds of group, as Google labels them: default (an email group), security (usable in access policies, and permanent once set), dynamic (members come from a query), or external (members from outside the directory)."
  type        = list(string)
  nullable    = false
  default     = ["default"]
  validation {
    condition     = length(var.types) > 0 && alltrue([for t in var.types : contains(["default", "dynamic", "security", "external"], t)])
    error_message = "Use one or more of default, dynamic, security, and external."
  }
}
