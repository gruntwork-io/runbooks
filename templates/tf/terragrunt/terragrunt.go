package terragrunt

import _ "embed"

//go:embed terragrunt.mdx
var mdxContent string

// Template generates a runbook that collects inputs and generates a terragrunt.hcl preview.
type Template struct{}

func (t *Template) Name() string      { return "::terragrunt" }
func (t *Template) MDXContent() string { return mdxContent }
