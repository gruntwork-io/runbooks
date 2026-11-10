include "root" {
  path = find_in_parent_folders("root.hcl")
}

include "google_provider" {
  path = "${get_repo_root()}/config/google-provider.hcl"
}

{{- if .id }}

# The {{ .id }} Google group.
{{- end }}
{{- if contains "?ref=" .ModuleSource }}
locals {
  # Release of the fabricahq/infra-catalog repository (common.hcl's catalog_source) that
  # provides modules/google-group.
  catalog_ref = {{ splitList "?ref=" .ModuleSource | last | toJson }}

  common = read_terragrunt_config("${get_repo_root()}/common.hcl").locals
}

terraform {
  source = "${local.common.catalog_source}//modules/google-group?ref=${local.catalog_ref}"
}
{{- else }}
terraform {
  source = {{ .ModuleSource | toJson }}
}
{{- end }}

inputs = {
  id = {{ .id | toJson }}
{{- if .display_name }}

  display_name = {{ .display_name | toJson }}
{{- end }}
{{- if .description }}

  description = {{ .description | toJson }}
{{- end }}
{{- if .domain }}

  domain = {{ .domain | toJson }}
{{- else }}

  customer_id = {{ .customer_id | toJson }}
{{- end }}
{{- if .owners }}

  owners = {{ .owners | toJson }}
{{- end }}
{{- if .managers }}

  managers = {{ .managers | toJson }}
{{- end }}
{{- if .members }}

  members = {{ .members | toJson }}
{{- end }}
{{- if ne (.types | toJson) "[\"default\"]" }}

  types = {{ .types | toJson }}
{{- end }}
}
