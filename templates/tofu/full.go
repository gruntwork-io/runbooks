package tofu

import (
	"bytes"
	_ "embed"
	"fmt"
	"text/template"
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
	tmpl, err := template.New("full.mdx").Parse(fullMDXTemplate)
	if err != nil {
		return "", fmt.Errorf("failed to parse full MDX template: %w", err)
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, ctx); err != nil {
		return "", fmt.Errorf("failed to render full MDX template: %w", err)
	}

	return buf.String(), nil
}

func (t *FullTemplate) GenerateFiles(ctx TemplateContext) (map[string][]byte, error) {
	// Start with the same files as basic
	basic := &BasicTemplate{}
	files, err := basic.GenerateFiles(ctx)
	if err != nil {
		return nil, err
	}

	// Add the copy-to-target script
	files["scripts/copy-to-target.sh"] = []byte(copyToTargetScript)

	return files, nil
}
