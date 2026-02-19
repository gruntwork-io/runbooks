package tofu

import "fmt"

// TemplateVariable holds the minimal info templates need about a variable.
type TemplateVariable struct {
	Name       string
	Type       string // Boilerplate type string (e.g. "string", "int", "list")
	HasDefault bool
}

// TemplateConfig holds serialized boilerplate config for file generation.
type TemplateConfig struct {
	// BoilerplateYAML is the pre-marshaled boilerplate.yml content
	BoilerplateYAML []byte
}

// TemplateContext provides data to runbook templates.
type TemplateContext struct {
	ModuleName     string
	ModuleNameSlug string
	ModuleSource   string
	VariableCount  int
	SectionSummary string
	SectionNames   []string
	Variables      []TemplateVariable
	Config         TemplateConfig
}

// RunbookTemplate defines how to generate a runbook from parsed OpenTofu variables.
type RunbookTemplate interface {
	Name() string
	// RenderMDX produces the runbook.mdx content
	RenderMDX(ctx TemplateContext) (string, error)
	// GenerateFiles produces all supporting files (boilerplate.yml, HCL templates, scripts)
	// Returns map of relative path -> file content
	GenerateFiles(ctx TemplateContext) (map[string][]byte, error)
}

var templates = map[string]RunbookTemplate{
	"basic": &BasicTemplate{},
	"full":  &FullTemplate{},
}

// GetTemplate returns a RunbookTemplate by name.
// An empty name returns the basic template.
func GetTemplate(name string) (RunbookTemplate, error) {
	if name == "" {
		name = "basic"
	}
	t, ok := templates[name]
	if !ok {
		return nil, fmt.Errorf("unknown template: %q (available: basic, full)", name)
	}
	return t, nil
}
