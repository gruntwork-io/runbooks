package api

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	tftmpl "runbooks/templates/tf"

	"gopkg.in/yaml.v3"
)

// GenerateRunbook writes a static MDX runbook from a built-in template.
// templateName selects a built-in template ("" = "terragrunt").
// Returns the path to runbook.mdx and a cleanup function for the temp directory.
func GenerateRunbook(templateName string) (string, func(), error) {
	tmpl, err := tftmpl.GetTemplate(templateName)
	if err != nil {
		return "", nil, err
	}

	tmpDir, err := os.MkdirTemp("", "runbooks-tf-*")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create temp directory: %w", err)
	}

	cleanup := func() {
		if err := os.RemoveAll(tmpDir); err != nil {
			slog.Warn("Failed to clean up temp directory", "path", tmpDir, "error", err)
		}
	}

	mdxPath := filepath.Join(tmpDir, "runbook.mdx")
	if err := os.WriteFile(mdxPath, []byte(tmpl.MDXContent()), 0644); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("failed to write runbook.mdx: %w", err)
	}

	slog.Info("Generated runbook from template",
		"template", tmpl.Name(),
		"outputDir", tmpDir,
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
		case ValidationRegex:
			if len(r.Args) > 0 {
				parts = append(parts, fmt.Sprintf("regex(%v)", r.Args[0]))
			}
		case ValidationLength:
			if len(r.Args) >= 2 {
				parts = append(parts, fmt.Sprintf("length-%v-%v", r.Args[0], r.Args[1]))
			}
		default:
			// Simple validations: the type string is the validation keyword
			// (e.g. ValidationRequired="required", ValidationURL="url", etc.)
			parts = append(parts, string(r.Type))
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
