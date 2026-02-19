package tofu

import (
	_ "embed"
)

//go:embed full.mdx.tmpl
var fullMDXTemplate string

//go:embed copy-to-target.sh
var copyToTargetScript string

// FullTemplate extends the basic template with deployment target, GitHub auth,
// git clone, file placement, and PR creation.
type FullTemplate struct{}

func (t *FullTemplate) Name() string { return "full" }

func (t *FullTemplate) RenderMDX(ctx TemplateContext) (string, error) {
	return renderMDXTemplate("full.mdx", fullMDXTemplate, ctx)
}

func (t *FullTemplate) GenerateFiles(ctx TemplateContext) (map[string][]byte, error) {
	files := make(map[string][]byte)

	// Only the copy-to-target script is needed as a supporting file.
	// The boilerplate.yml and terragrunt.hcl template are no longer generated —
	// <TfModule> parses the module at runtime and <TemplateInline> renders inline.
	files["scripts/copy-to-target.sh"] = []byte(copyToTargetScript)

	return files, nil
}
