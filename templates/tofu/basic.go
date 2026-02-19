package tofu

import (
	_ "embed"
)

//go:embed basic.mdx.tmpl
var basicMDXTemplate string

// BasicTemplate generates a runbook that collects inputs and generates a terragrunt.hcl preview.
// Uses <TfModule> for runtime module parsing and <TemplateInline> for inline template rendering,
// so no supporting files (boilerplate.yml, terragrunt.hcl template) are needed.
type BasicTemplate struct{}

func (t *BasicTemplate) Name() string { return "basic" }

func (t *BasicTemplate) RenderMDX(ctx TemplateContext) (string, error) {
	return renderMDXTemplate("basic.mdx", basicMDXTemplate, ctx)
}

func (t *BasicTemplate) GenerateFiles(ctx TemplateContext) (map[string][]byte, error) {
	// No supporting files needed — <TfModule> parses the module at runtime
	// and <TemplateInline> renders the template inline in the MDX.
	return map[string][]byte{}, nil
}
