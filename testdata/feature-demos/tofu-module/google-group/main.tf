# A Google group in a Google Workspace or Cloud Identity organization, with its owners, managers, and members.
# Adapted from terraform-google-modules/terraform-google-group (Apache License 2.0, Copyright 2018 Google LLC).

data "google_organization" "org" {
  count  = var.domain == "" ? 0 : 1
  domain = var.domain
}

locals {
  customer_id = var.domain == "" ? var.customer_id : data.google_organization.org[0].directory_customer_id
  label_keys = {
    default  = "cloudidentity.googleapis.com/groups.discussion_forum"
    dynamic  = "cloudidentity.googleapis.com/groups.dynamic"
    security = "cloudidentity.googleapis.com/groups.security"
    external = "system/groups/external"
  }
}

resource "google_cloud_identity_group" "group" {
  display_name         = var.display_name
  description          = var.description
  parent               = "customers/${local.customer_id}"
  initial_group_config = var.initial_group_config

  group_key {
    id = var.id
  }

  labels = { for t in var.types : local.label_keys[t] => "" }
}

# Google requires the MEMBER role on every membership, alongside OWNER or MANAGER.
resource "google_cloud_identity_group_membership" "owners" {
  for_each = toset(var.owners)
  group    = google_cloud_identity_group.group.id

  preferred_member_key { id = each.key }
  roles { name = "OWNER" }
  roles { name = "MEMBER" }
}

resource "google_cloud_identity_group_membership" "managers" {
  for_each = toset(var.managers)
  group    = google_cloud_identity_group.group.id

  preferred_member_key { id = each.key }
  roles { name = "MEMBER" }
  roles { name = "MANAGER" }
}

resource "google_cloud_identity_group_membership" "members" {
  for_each = toset(var.members)
  group    = google_cloud_identity_group.group.id

  preferred_member_key { id = each.key }
  roles { name = "MEMBER" }
}
