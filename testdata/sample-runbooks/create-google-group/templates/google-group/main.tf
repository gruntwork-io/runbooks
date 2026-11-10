terraform {
  required_providers {
    google = { source = "hashicorp/google", version = ">= 8.10.0, < 9.0.0" }
  }
}

# Reads back the project the session signed in to.
provider "google" {
  alias = "signed_in"
}

data "google_client_config" "signed_in" {
  provider = google.signed_in
}

# Bills API calls to that project: Cloud Identity refuses user credentials without a quota project.
provider "google" {
  billing_project       = data.google_client_config.signed_in.project
  user_project_override = true
}

module "group" {
  source = {{ .ModuleSource | toJson }}

  id           = {{ .id | toJson }}
  display_name = {{ .display_name | toJson }}
  description  = {{ .description | toJson }}
  domain       = {{ .domain | toJson }}
  customer_id  = {{ .customer_id | toJson }}
  owners       = {{ .owners | toJson }}
  managers     = {{ .managers | toJson }}
  members      = {{ .members | toJson }}
  types        = {{ .types | toJson }}
}

output "email" {
  description = "Email address of the group."
  value       = module.group.email
}

output "resource_name" {
  description = "Google's resource name for the group, groups/<id>."
  value       = module.group.resource_name
}

output "customer_id" {
  description = "Customer ID of the organization that holds the group."
  value       = module.group.customer_id
}

output "runbooks_console_url" {
  description = "The group's page in the Google Admin console."
  value       = module.group.runbooks_console_url
}
