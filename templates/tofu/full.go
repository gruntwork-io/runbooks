package tofu

import (
	_ "embed"
)

//go:embed full.mdx.tmpl
var fullMDXTemplate string

//go:embed place-in-repo.sh
var placeInRepoScript string

// FullTemplate extends the basic template with deployment target, GitHub auth,
// git clone, file placement in the target repo, and PR creation.
type FullTemplate struct{}

func (t *FullTemplate) Name() string { return "full" }

func (t *FullTemplate) RenderMDX(ctx TemplateContext) (string, error) {
	return renderMDXTemplate("full.mdx", fullMDXTemplate, ctx)
}

func (t *FullTemplate) GenerateFiles(ctx TemplateContext) (map[string][]byte, error) {
	files := make(map[string][]byte)
	files["scripts/place-in-repo.sh"] = []byte(placeInRepoScript)
	return files, nil
}
