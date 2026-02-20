package opentofu

import _ "embed"

//go:embed opentofu.mdx
var mdxContent string

// Template generates a runbook that collects inputs and generates a main.tf preview.
type Template struct{}

func (t *Template) Name() string      { return "::tofu" }
func (t *Template) MDXContent() string { return mdxContent }
