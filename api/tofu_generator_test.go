package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGenerateRunbook_Basic(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/s3-bucket"

	mdxPath, cleanup, err := GenerateRunbook(fixtureDir, "", "basic")
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	// Verify runbook.mdx was created
	assert.True(t, strings.HasSuffix(mdxPath, "runbook.mdx"))
	mdxContent, err := os.ReadFile(mdxPath)
	require.NoError(t, err)

	mdx := string(mdxContent)
	assert.Contains(t, mdx, "s3-bucket")
	assert.Contains(t, mdx, "<TfModule")
	assert.Contains(t, mdx, "module-vars")
	assert.Contains(t, mdx, "<TemplateInline")
	assert.Contains(t, mdx, "terragrunt.hcl")
	assert.Contains(t, mdx, "_module.hcl_inputs")
	assert.Contains(t, mdx, "_module.source")

	// Basic template no longer generates supporting files — TfModule parses at runtime
	dir := filepath.Dir(mdxPath)
	_, err = os.Stat(filepath.Join(dir, "templates", "module-inputs", "boilerplate.yml"))
	assert.True(t, os.IsNotExist(err), "boilerplate.yml should not be generated")
}

func TestGenerateRunbook_Full(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/lambda-function"

	mdxPath, cleanup, err := GenerateRunbook(fixtureDir, "", "full")
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	mdxContent, err := os.ReadFile(mdxPath)
	require.NoError(t, err)

	mdx := string(mdxContent)
	assert.Contains(t, mdx, "Deploy lambda-function")
	assert.Contains(t, mdx, "<GitHubAuth")
	assert.Contains(t, mdx, "<GitClone")
	assert.Contains(t, mdx, "<GitHubPullRequest")
	assert.Contains(t, mdx, "deploy-config")
	assert.Contains(t, mdx, "<TfModule")
	assert.Contains(t, mdx, "<TemplateInline")
	assert.Contains(t, mdx, "place-in-repo.sh")

	// Verify place-in-repo.sh was created
	dir := filepath.Dir(mdxPath)
	scriptPath := filepath.Join(dir, "scripts", "place-in-repo.sh")
	_, err = os.Stat(scriptPath)
	assert.NoError(t, err, "place-in-repo.sh should exist")
}

func TestGenerateRunbook_DefaultTemplate(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/s3-bucket"

	// Empty string should use basic template
	mdxPath, cleanup, err := GenerateRunbook(fixtureDir, "", "")
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	mdxContent, err := os.ReadFile(mdxPath)
	require.NoError(t, err)

	// Basic template uses "Configure" not "Deploy"
	assert.Contains(t, string(mdxContent), "Configure s3-bucket")
}

func TestGenerateRunbook_InvalidTemplate(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/s3-bucket"

	_, _, err := GenerateRunbook(fixtureDir, "", "nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unknown template")
}

func TestGenerateRunbook_InvalidPath(t *testing.T) {
	_, _, err := GenerateRunbook("/nonexistent/path", "", "basic")
	require.Error(t, err)
}

func TestGenerateRunbook_ComplexModule(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/lambda-s3-complex"

	mdxPath, cleanup, err := GenerateRunbook(fixtureDir, "", "basic")
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	// Verify MDX references the module path and contains TfModule + TemplateInline
	mdxContent, err := os.ReadFile(mdxPath)
	require.NoError(t, err)
	mdx := string(mdxContent)
	assert.Contains(t, mdx, "<TfModule")
	assert.Contains(t, mdx, "<TemplateInline")
	assert.Contains(t, mdx, "lambda-s3-complex")
}

func TestGenerateRunbook_OriginalSource(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/s3-bucket"
	remoteURL := "github.com/my-org/infra-modules//modules/s3-bucket?ref=v1.0.0"

	mdxPath, cleanup, err := GenerateRunbook(fixtureDir, remoteURL, "basic")
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	mdxContent, err := os.ReadFile(mdxPath)
	require.NoError(t, err)

	mdx := string(mdxContent)
	// The generated TfModule source should use the original remote URL, not the local path
	assert.Contains(t, mdx, remoteURL)
	assert.NotContains(t, mdx, fixtureDir)
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
	assert.Contains(t, yaml, "- regex(^[a-z]+$)")
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
			expected: []string{"required", "regex(^[a-z]+$)"},
		},
		{
			name: "length",
			rules: []ValidationRule{
				{Type: ValidationLength, Args: []interface{}{3, 50}},
			},
			expected: []string{"length-3-50"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, validationsToList(tt.rules))
		})
	}
}
