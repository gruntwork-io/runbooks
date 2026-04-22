package tf

import (
	"fmt"

	"github.com/gruntwork-io/runbooks/templates/tf/opentofu"
	"github.com/gruntwork-io/runbooks/templates/tf/terragrunt"
	terragruntgithub "github.com/gruntwork-io/runbooks/templates/tf/terragrunt-github"
)

// GruntbookTemplate defines a built-in gruntbook template backed by a static MDX file.
type GruntbookTemplate interface {
	Name() string
	MDXContent() string
}

var templates = map[string]GruntbookTemplate{
	"::terragrunt":        &terragrunt.Template{},
	"::terragrunt-github": &terragruntgithub.Template{},
	"::tofu":              &opentofu.Template{},
}

// GetTemplate returns a GruntbookTemplate by name.
// An empty name returns the ::terragrunt template.
func GetTemplate(name string) (GruntbookTemplate, error) {
	if name == "" {
		name = "::terragrunt"
	}
	t, ok := templates[name]
	if !ok {
		return nil, fmt.Errorf("unknown template: %q (available: ::terragrunt, ::terragrunt-github, ::tofu)", name)
	}
	return t, nil
}
