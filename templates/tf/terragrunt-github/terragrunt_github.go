package terragruntgithub

import _ "embed"

//go:embed terragrunt-github.mdx
var mdxContent string

// Template generates a runbook that clones a GitHub repo, picks a directory,
// collects module inputs, generates a terragrunt.hcl, and opens a pull request.
type Template struct{}

func (t *Template) Name() string      { return "::terragrunt-github" }
func (t *Template) MDXContent() string { return mdxContent }
