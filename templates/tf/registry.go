package tf

import (
	"fmt"

	"runbooks/templates/tf/opentofu"
	"runbooks/templates/tf/terragrunt"
	terragruntgithub "runbooks/templates/tf/terragrunt-github"
)

// RunbookTemplate defines a built-in runbook template backed by a static MDX file.
type RunbookTemplate interface {
	Name() string
	MDXContent() string
}

var templates = map[string]RunbookTemplate{
	"::terragrunt":        &terragrunt.Template{},
	"::terragrunt-github": &terragruntgithub.Template{},
	"::tofu":              &opentofu.Template{},
}

// GetTemplate returns a RunbookTemplate by name.
// An empty name returns the ::terragrunt template.
func GetTemplate(name string) (RunbookTemplate, error) {
	if name == "" {
		name = "::terragrunt"
	}
	t, ok := templates[name]
	if !ok {
		return nil, fmt.Errorf("unknown template: %q (available: ::terragrunt, ::terragrunt-github, ::tofu)", name)
	}
	return t, nil
}
