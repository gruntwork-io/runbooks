terraform {
  source = "{{ ._module.source }}"
}

include "root" {
  path   = find_in_parent_folders("root.hcl")
  expose = true
}

inputs = {
{{- range $name, $hcl := ._module.hcl_inputs }}
  {{ $name }} = {{ $hcl }}
{{- end }}
}
