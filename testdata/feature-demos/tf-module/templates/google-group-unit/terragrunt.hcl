include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = {{ .ModuleSource | toJson }}
}

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
