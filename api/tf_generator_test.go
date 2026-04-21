package api

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGenerateGruntbook_Terragrunt(t *testing.T) {
	mdxPath, cleanup, err := GenerateGruntbook("::terragrunt")
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	assert.True(t, strings.HasSuffix(mdxPath, "gruntbook.mdx"))
	mdxContent, err := os.ReadFile(mdxPath)
	require.NoError(t, err)

	mdx := string(mdxContent)
	assert.Contains(t, mdx, "::cli_gruntbook_source")
	assert.Contains(t, mdx, "<TfModule")
	assert.Contains(t, mdx, "<TemplateInline")
	assert.Contains(t, mdx, "terragrunt.hcl")
}

func TestGenerateGruntbook_Tofu(t *testing.T) {
	mdxPath, cleanup, err := GenerateGruntbook("::tofu")
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	mdxContent, err := os.ReadFile(mdxPath)
	require.NoError(t, err)

	mdx := string(mdxContent)
	assert.Contains(t, mdx, "::cli_gruntbook_source")
	assert.Contains(t, mdx, "<TfModule")
	assert.Contains(t, mdx, "main.tf")

	// No supporting files — just gruntbook.mdx
	dir, _ := os.ReadDir(mdxPath[:len(mdxPath)-len("gruntbook.mdx")])
	assert.Len(t, dir, 1)
}

func TestGenerateGruntbook_TerragruntGitHub(t *testing.T) {
	mdxPath, cleanup, err := GenerateGruntbook("::terragrunt-github")
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	mdxContent, err := os.ReadFile(mdxPath)
	require.NoError(t, err)

	mdx := string(mdxContent)
	assert.Contains(t, mdx, "<GitHubAuth")
	assert.Contains(t, mdx, "<GitClone")
	assert.Contains(t, mdx, "<DirPicker")
	assert.Contains(t, mdx, "<TfModule")
	assert.Contains(t, mdx, "::cli_gruntbook_source")
	assert.Contains(t, mdx, "<TemplateInline")
	assert.Contains(t, mdx, "terragrunt.hcl")
	assert.Contains(t, mdx, "<GitHubPullRequest")
	assert.Contains(t, mdx, "target=\"worktree\"")
	assert.Contains(t, mdx, ".outputs.target_path.PATH")
	assert.Contains(t, mdx, ".outputs.module_vars.MODULE_NAME")
}

func TestGenerateGruntbook_DefaultTemplate(t *testing.T) {
	// Empty string should use terragrunt template
	mdxPath, cleanup, err := GenerateGruntbook("")
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	mdxContent, err := os.ReadFile(mdxPath)
	require.NoError(t, err)

	assert.Contains(t, string(mdxContent), "terragrunt.hcl")
}

func TestGenerateGruntbook_InvalidTemplate(t *testing.T) {
	_, _, err := GenerateGruntbook("nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unknown template")
}

func TestMarshalBoilerplateConfig(t *testing.T) {
	config := &BoilerplateConfig{
		Variables: []BoilerplateVariable{
			{
				Name:        "test_var",
				Type:        VarTypeString,
				Description: "A test variable",
				Required:    true,
				Validations: []ValidationRule{
					{Type: ValidationRequired, Message: "required"},
					{Type: ValidationRegex, Message: "must match", Args: []interface{}{"^[a-z]+$"}},
				},
				SectionName: "Testing",
			},
			{
				Name:    "enum_var",
				Type:    VarTypeEnum,
				Options: []string{"a", "b", "c"},
			},
		},
	}

	yamlBytes, err := marshalBoilerplateConfig(config)
	require.NoError(t, err)

	yaml := string(yamlBytes)
	assert.Contains(t, yaml, "test_var")
	// Validations are emitted as a YAML list, not a string
	assert.Contains(t, yaml, "- required")
	assert.Contains(t, yaml, `- regex("^[a-z]+$")`)
	assert.Contains(t, yaml, "x-section: Testing")
	assert.Contains(t, yaml, "enum_var")
	assert.Contains(t, yaml, "options:")
}

func TestValidationsToList(t *testing.T) {
	tests := []struct {
		name     string
		rules    []ValidationRule
		expected []string
	}{
		{
			name:     "empty",
			rules:    nil,
			expected: nil,
		},
		{
			name:     "required only",
			rules:    []ValidationRule{{Type: ValidationRequired}},
			expected: []string{"required"},
		},
		{
			name: "required with regex",
			rules: []ValidationRule{
				{Type: ValidationRequired},
				{Type: ValidationRegex, Args: []interface{}{"^[a-z]+$"}},
			},
			expected: []string{"required", `regex("^[a-z]+$")`},
		},
		{
			name: "length",
			rules: []ValidationRule{
				{Type: ValidationLength, Args: []interface{}{3, 50}},
			},
			expected: []string{"length(3, 50)"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, validationsToList(tt.rules))
		})
	}
}
