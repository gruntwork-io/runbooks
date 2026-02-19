package tofu

import (
	_ "embed"
	"fmt"
	"strings"
)

//go:embed basic.mdx.tmpl
var basicMDXTemplate string

// BasicTemplate generates a runbook that collects inputs and generates a terragrunt.hcl preview.
type BasicTemplate struct{}

func (t *BasicTemplate) Name() string { return "basic" }

func (t *BasicTemplate) RenderMDX(ctx TemplateContext) (string, error) {
	return renderMDXTemplate("basic.mdx", basicMDXTemplate, ctx)
}

func (t *BasicTemplate) GenerateFiles(ctx TemplateContext) (map[string][]byte, error) {
	files := make(map[string][]byte)

	// boilerplate.yml is pre-marshaled by the generator
	files["templates/module-inputs/boilerplate.yml"] = ctx.Config.BoilerplateYAML

	// Generate terragrunt.hcl template
	tgHCL := generateTerragruntHCL(ctx)
	files["templates/module-inputs/terragrunt.hcl"] = []byte(tgHCL)

	return files, nil
}

// generateTerragruntHCL builds a Go-template terragrunt.hcl from the parsed variables.
func generateTerragruntHCL(ctx TemplateContext) string {
	var sb strings.Builder

	sb.WriteString(`terraform {
  source = "`)
	sb.WriteString(ctx.ModuleSource)
	sb.WriteString(`"
}

include "root" {
  path   = find_in_parent_folders("root.hcl")
  expose = true
}

inputs = {
`)

	for _, v := range ctx.Variables {
		varName := v.Name
		bpType := v.Type

		switch {
		case bpType == "bool" || bpType == "int" || bpType == "float":
			if v.HasDefault {
				sb.WriteString(fmt.Sprintf("  {{- if .%s }}\n", varName))
				sb.WriteString(fmt.Sprintf("  %s = {{ .%s }}\n", varName, varName))
				sb.WriteString("  {{- end }}\n")
			} else {
				sb.WriteString(fmt.Sprintf("  %s = {{ .%s }}\n", varName, varName))
			}
		case bpType == "list" || bpType == "map":
			if v.HasDefault {
				sb.WriteString(fmt.Sprintf("  {{- if .%s }}\n", varName))
				sb.WriteString(fmt.Sprintf("  %s = {{ toJson .%s }}\n", varName, varName))
				sb.WriteString("  {{- end }}\n")
			} else {
				sb.WriteString(fmt.Sprintf("  %s = {{ toJson .%s }}\n", varName, varName))
			}
		default: // string, enum
			if v.HasDefault {
				sb.WriteString(fmt.Sprintf("  {{- if .%s }}\n", varName))
				sb.WriteString(fmt.Sprintf("  %s = \"{{ .%s }}\"\n", varName, varName))
				sb.WriteString("  {{- end }}\n")
			} else {
				sb.WriteString(fmt.Sprintf("  %s = \"{{ .%s }}\"\n", varName, varName))
			}
		}
	}

	sb.WriteString("}\n")
	return sb.String()
}
