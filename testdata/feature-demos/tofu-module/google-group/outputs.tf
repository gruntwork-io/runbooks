output "email" {
  description = "Email address of the group."
  value       = google_cloud_identity_group.group.group_key[0].id
}

output "resource_name" {
  description = "Google's resource name for the group, groups/<id>."
  value       = google_cloud_identity_group.group.name
}

output "customer_id" {
  description = "Customer ID of the organization that holds the group."
  value       = local.customer_id
}
