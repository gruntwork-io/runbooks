package api

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"runbooks/templates/tofu"

	"gopkg.in/yaml.v3"
)

// GenerateRunbook parses a tofu module and generates a complete runbook directory.
// modulePath is the local path to parse. originalSource is the source string to embed
// in the generated <TfModule source="..."> — when empty, defaults to modulePath.
// This distinction matters for remote modules: modulePath is the temp directory clone,
// but originalSource is the original URL (e.g., "github.com/org/repo//modules/vpc").
// templateName selects a built-in template ("" = "basic"). Returns the path to the
// generated runbook.mdx and a cleanup function for the temp directory.
func GenerateRunbook(modulePath string, originalSource string, templateName string) (string, func(), error) {
	// 1. Parse the module
	absPath, err := filepath.Abs(modulePath)
	if err != nil {
		return "", nil, fmt.Errorf("failed to resolve module path: %w", err)
	}

	vars, err := ParseTofuModule(absPath)
	if err != nil {
		return "", nil, fmt.Errorf("failed to parse OpenTofu module: %w", err)
	}

	slog.Info("Parsed OpenTofu module", "path", absPath, "variableCount", len(vars))

	// 2. Convert to boilerplate config
	config := MapToBoilerplateConfig(vars)

	// 3. Marshal boilerplate config to YAML for the template
	bpYAML, err := marshalBoilerplateConfig(config)
	if err != nil {
		return "", nil, fmt.Errorf("failed to marshal boilerplate config: %w", err)
	}

	// 4. Convert variables to template-safe format
	templateVars := make([]tofu.TemplateVariable, len(vars))
	for i, v := range vars {
		templateVars[i] = tofu.TemplateVariable{
			Name:       v.Name,
			Type:       string(MapTofuType(v.Type)),
			HasDefault: v.HasDefault,
		}
	}

	// 5. Build template context
	// Use originalSource for the MDX template if provided, otherwise fall back to absPath.
	// This preserves the remote URL for generated <TfModule source="..."> tags.
	moduleSource := absPath
	if originalSource != "" {
		moduleSource = originalSource
	}
	moduleName := filepath.Base(absPath)
	ctx := tofu.TemplateContext{
		ModuleName:     moduleName,
		ModuleNameSlug: slugify(moduleName),
		ModuleSource:   moduleSource,
		VariableCount:  len(vars),
		Variables:      templateVars,
		Config:         tofu.TemplateConfig{BoilerplateYAML: bpYAML},
	}

	// Build section summary
	var sectionNames []string
	for _, s := range config.Sections {
		if s.Name != "" {
			sectionNames = append(sectionNames, s.Name)
		}
	}
	ctx.SectionNames = sectionNames
	ctx.SectionSummary = strings.Join(sectionNames, ", ")

	// 6. Look up template
	tmpl, err := tofu.GetTemplate(templateName)
	if err != nil {
		return "", nil, err
	}

	// 7. Create temp directory
	tmpDir, err := os.MkdirTemp("", "runbooks-tofu-*")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create temp directory: %w", err)
	}

	cleanup := func() {
		if err := os.RemoveAll(tmpDir); err != nil {
			slog.Warn("Failed to clean up temp directory", "path", tmpDir, "error", err)
		}
	}

	// 8. Render MDX
	mdxContent, err := tmpl.RenderMDX(ctx)
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("failed to render MDX: %w", err)
	}

	mdxPath := filepath.Join(tmpDir, "runbook.mdx")
	if err := os.WriteFile(mdxPath, []byte(mdxContent), 0644); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("failed to write runbook.mdx: %w", err)
	}

	// 9. Generate supporting files
	files, err := tmpl.GenerateFiles(ctx)
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("failed to generate files: %w", err)
	}

	for relPath, content := range files {
		fullPath := filepath.Join(tmpDir, relPath)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			cleanup()
			return "", nil, fmt.Errorf("failed to create directory for %s: %w", relPath, err)
		}
		if err := os.WriteFile(fullPath, content, 0644); err != nil {
			cleanup()
			return "", nil, fmt.Errorf("failed to write %s: %w", relPath, err)
		}
	}

	slog.Info("Generated runbook from OpenTofu module",
		"modulePath", absPath,
		"template", tmpl.Name(),
		"outputDir", tmpDir,
		"fileCount", len(files)+1,
	)

	return mdxPath, cleanup, nil
}

// marshalBoilerplateConfig converts a BoilerplateConfig to a boilerplate.yml YAML file.
// Validations are emitted as a YAML list so that boilerplate's unmarshalValidationsField
// processes each rule individually via convertSingleValidationRule, avoiding issues with
// space-splitting regex patterns.
func marshalBoilerplateConfig(config *BoilerplateConfig) ([]byte, error) {
	type yamlVariable struct {
		Name        string            `yaml:"name"`
		Type        string            `yaml:"type"`
		Description string            `yaml:"description,omitempty"`
		Default     any               `yaml:"default,omitempty"`
		Options     []string          `yaml:"options,omitempty"`
		Validations []string          `yaml:"validations,omitempty"`
		XSection    string            `yaml:"x-section,omitempty"`
		XSchema     map[string]string `yaml:"x-schema,omitempty"`
	}
	type yamlConfig struct {
		Variables []yamlVariable `yaml:"variables"`
	}

	yc := yamlConfig{
		Variables: make([]yamlVariable, 0, len(config.Variables)),
	}

	for _, v := range config.Variables {
		yv := yamlVariable{
			Name:        v.Name,
			Type:        string(v.Type),
			Description: v.Description,
			Default:     v.Default,
			Options:     v.Options,
			XSection:    v.SectionName,
			XSchema:     v.Schema,
		}

		yv.Validations = validationsToList(v.Validations)
		yc.Variables = append(yc.Variables, yv)
	}

	return yaml.Marshal(yc)
}

// validationsToList converts ValidationRules to a list of boilerplate validation strings.
// Each rule becomes a separate list item so that boilerplate's YAML list parser handles
// each rule individually (including regex patterns with special characters).
// e.g., []string{"required", "regex(^vpc-[0-9a-f]{8,17}$)"} or []string{"required", "length-3-50"}
func validationsToList(rules []ValidationRule) []string {
	if len(rules) == 0 {
		return nil
	}

	var parts []string
	for _, r := range rules {
		switch r.Type {
		case ValidationRequired:
			parts = append(parts, "required")
		case ValidationRegex:
			if len(r.Args) > 0 {
				parts = append(parts, fmt.Sprintf("regex(%v)", r.Args[0]))
			}
		case ValidationLength:
			if len(r.Args) >= 2 {
				parts = append(parts, fmt.Sprintf("length-%v-%v", r.Args[0], r.Args[1]))
			}
		case ValidationURL:
			parts = append(parts, "url")
		case ValidationEmail:
			parts = append(parts, "email")
		case ValidationAlpha:
			parts = append(parts, "alpha")
		case ValidationDigit:
			parts = append(parts, "digit")
		case ValidationAlphanumeric:
			parts = append(parts, "alphanumeric")
		case ValidationSemver:
			parts = append(parts, "semver")
		case ValidationCountryCode2:
			parts = append(parts, "countrycode2")
		}
	}

	return parts
}

var nonAlphanumericRe = regexp.MustCompile(`[^a-z0-9-]`)
var multiDashRe = regexp.MustCompile(`-+`)

// slugify converts a string to a URL/branch-safe slug.
func slugify(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, "_", "-")
	s = strings.ReplaceAll(s, " ", "-")
	s = nonAlphanumericRe.ReplaceAllString(s, "")
	s = multiDashRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	return s
}
