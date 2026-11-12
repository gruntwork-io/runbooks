include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = {{ .ModuleSource | toJson }}
}

inputs = {
{{ .InputsHcl }}
}
