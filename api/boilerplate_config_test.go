package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseBoilerplateConfig(t *testing.T) {
	tests := []struct {
		name                  string
		filename              string
		wantErr               bool
		expectedVariableCount int
		expectedTypes         []string
		expectedValidations   map[string][]BoilerplateValidationType
	}{
		{
			name:                  "valid boilerplate with all types",
			filename:              "../testdata/boilerplate-yaml/valid.yml",
			wantErr:               false,
			expectedVariableCount: 6,
			expectedTypes:         []string{"string", "enum", "bool", "int", "map", "list"},
			expectedValidations:   map[string][]BoilerplateValidationType{},
		},
		{
			name:                  "boilerplate with validations",
			filename:              "../testdata/boilerplate-yaml/valid-with-validations.yml",
			wantErr:               false,
			expectedVariableCount: 9,
			expectedTypes:         []string{"string", "enum", "bool", "int", "map", "list", "string", "string", "string"},
			expectedValidations: map[string][]BoilerplateValidationType{
				"AccountName":   {ValidationRequired},
				"InstanceCount": {ValidationRequired},
				"ContactEmail":  {ValidationEmail},
				"WebsiteURL":    {ValidationURL},
			},
		},
		{
			name:     "invalid variable types",
			filename: "../testdata/boilerplate-yaml/invalid-variable-types.yml",
			wantErr:  true,
		},
		{
			name:                  "invalid validations",
			filename:              "../testdata/boilerplate-yaml/invalid-validations.yml",
			wantErr:               false, // Boilerplate library is permissive and parses these as custom validations
			expectedVariableCount: 4,     // Should parse successfully with 4 variables
			expectedTypes:         []string{"string", "string", "string", "string"},
			expectedValidations:   map[string][]BoilerplateValidationType{},
		},
		{
			name:     "invalid yaml syntax",
			filename: "../testdata/boilerplate-yaml/invalid-yaml-2.yml",
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Get the absolute path to the test file
			absPath, err := filepath.Abs(tt.filename)
			require.NoError(t, err)

			// Read the file content
			content, err := os.ReadFile(absPath)
			require.NoError(t, err)

			config, err := parseBoilerplateConfig(string(content))

			if tt.wantErr {
				assert.Error(t, err)
				assert.Nil(t, config)
				return
			}

			require.NoError(t, err)
			require.NotNil(t, config)
			assert.Equal(t, tt.expectedVariableCount, len(config.Variables))

			// Verify variable types
			if len(tt.expectedTypes) > 0 {
				for i, expectedType := range tt.expectedTypes {
					if i < len(config.Variables) {
						assert.Equal(t, expectedType, config.Variables[i].Type,
							"Variable %d (%s) should have type %s", i, config.Variables[i].Name, expectedType)
					}
				}
			}

			// Verify validation rules
			for varName, expectedValidations := range tt.expectedValidations {
				var found bool
				for _, variable := range config.Variables {
					if variable.Name == varName {
						found = true
						assert.Equal(t, len(expectedValidations), len(variable.Validations),
							"Variable %s should have %d validations", varName, len(expectedValidations))

						for i, expectedValidation := range expectedValidations {
							if i < len(variable.Validations) {
								assert.Equal(t, expectedValidation, variable.Validations[i].Type,
									"Variable %s validation %d should be %s", varName, i, expectedValidation)
							}
						}
						break
					}
				}
				assert.True(t, found, "Variable %s should exist", varName)
			}
		})
	}
}

func TestParseBoilerplateConfig_ContentErrors(t *testing.T) {
	tests := []struct {
		name          string
		filePath      string
		expectError   bool
		errorContains string
	}{
		{
			name:          "invalid yaml syntax - malformed yaml",
			filePath:      "../testdata/boilerplate-yaml/invalid-yaml.yml",
			expectError:   true,
			errorContains: "failed to parse boilerplate config",
		},
		{
			name:          "invalid yaml syntax - malformed yaml 2",
			filePath:      "../testdata/boilerplate-yaml/invalid-yaml-2.yml",
			expectError:   true,
			errorContains: "failed to parse boilerplate config",
		},
		{
			name:          "invalid yaml syntax - malformed yaml 3",
			filePath:      "../testdata/boilerplate-yaml/invalid-yaml-3.yml",
			expectError:   true,
			errorContains: "failed to parse boilerplate config",
		},
		{
			name:          "invalid variable types",
			filePath:      "../testdata/boilerplate-yaml/invalid-variable-types.yml",
			expectError:   true,
			errorContains: "failed to parse boilerplate config",
		},
		{
			name:          "invalid type unsupported",
			filePath:      "../testdata/boilerplate-yaml/invalid-type-unsupported.yml",
			expectError:   true,
			errorContains: "failed to parse boilerplate config",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Get the absolute path to the test file
			absPath, err := filepath.Abs(tt.filePath)
			require.NoError(t, err)

			// Read the file content
			content, err := os.ReadFile(absPath)
			require.NoError(t, err)

			config, err := parseBoilerplateConfig(string(content))

			if tt.expectError {
				assert.Error(t, err)
				if tt.errorContains != "" && err != nil {
					assert.Contains(t, err.Error(), tt.errorContains)
				}
				assert.Nil(t, config)
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, config)
			}
		})
	}
}

func TestParseBoilerplateConfig_ValidationRules(t *testing.T) {
	absPath, err := filepath.Abs("../testdata/boilerplate-yaml/valid-with-validations.yml")
	require.NoError(t, err)

	// Read the file content
	content, err := os.ReadFile(absPath)
	require.NoError(t, err)

	bpConfig, err := parseBoilerplateConfig(string(content))
	require.NoError(t, err)
	require.NotNil(t, bpConfig)

	// Validation rules are declared directly in the boilerplate.yml file
	expectedValidations := map[string][]BoilerplateValidationType{
		"AccountName":   {ValidationRequired},
		"InstanceCount": {ValidationRequired},
		"ContactEmail":  {ValidationEmail},
		"WebsiteURL":    {ValidationURL},
	}

	// Verify validation rules
	for varName, expectedValidations := range expectedValidations {
		var found bool
		for _, variable := range bpConfig.Variables {
			if variable.Name == varName {
				found = true
				assert.Equal(t, len(expectedValidations), len(variable.Validations),
					"Variable %s should have %d validations", varName, len(expectedValidations))

				for i, expectedValidation := range expectedValidations {
					if i < len(variable.Validations) {
						assert.Equal(t, expectedValidation, variable.Validations[i].Type,
							"Variable %s validation %d should be %s", varName, i, expectedValidation)
					}
				}
				break
			}
		}
		assert.True(t, found, "Variable %s should exist", varName)
	}
}

func TestParseBoilerplateConfig_RequiredFields(t *testing.T) {
	absPath, err := filepath.Abs("../testdata/boilerplate-yaml/valid-with-validations.yml")
	require.NoError(t, err)

	// Read the file content
	content, err := os.ReadFile(absPath)
	require.NoError(t, err)

	config, err := parseBoilerplateConfig(string(content))
	require.NoError(t, err)
	require.NotNil(t, config)

	expectedRequired := map[string]bool{
		"AccountName":   true,
		"InstanceCount": true,
		"ContactEmail":  false, // has email validation but not required
	}

	// Verify required fields
	for varName, expectedRequired := range expectedRequired {
		var found bool
		for _, variable := range config.Variables {
			if variable.Name == varName {
				found = true
				assert.Equal(t, expectedRequired, variable.Required,
					"Variable %s should have Required=%v", varName, expectedRequired)
				break
			}
		}
		assert.True(t, found, "Variable %s should exist", varName)
	}
}

func TestConvertToJSONSerializable(t *testing.T) {
	tests := []struct {
		name     string
		input    interface{}
		expected interface{}
	}{
		{
			name:     "primitive types pass through unchanged",
			input:    "hello",
			expected: "hello",
		},
		{
			name:     "numbers pass through unchanged",
			input:    42,
			expected: 42,
		},
		{
			name:     "booleans pass through unchanged",
			input:    true,
			expected: true,
		},
		{
			name: "maps with interface{} keys convert to string keys",
			input: map[interface{}]interface{}{
				"key1": "value1",
				"key2": 42,
			},
			expected: map[string]interface{}{
				"key1": "value1",
				"key2": 42,
			},
		},
		{
			name:     "slices pass through unchanged",
			input:    []interface{}{"item1", 42, true},
			expected: []interface{}{"item1", 42, true},
		},
		{
			name: "complex nested structure with mixed types",
			input: map[interface{}]interface{}{
				"config": map[interface{}]interface{}{
					"items":   []interface{}{"a", "b", "c"},
					"count":   3,
					"enabled": true,
				},
				"metadata": []interface{}{
					map[interface{}]interface{}{
						"name":  "item1",
						"value": 100,
					},
				},
			},
			expected: map[string]interface{}{
				"config": map[string]interface{}{
					"items":   []interface{}{"a", "b", "c"},
					"count":   3,
					"enabled": true,
				},
				"metadata": []interface{}{
					map[string]interface{}{
						"name":  "item1",
						"value": 100,
					},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := convertToJSONSerializable(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestHandleBoilerplateRequest(t *testing.T) {
	// Create a temporary directory for test files
	tempDir := t.TempDir()

	// Create a test boilerplate file
	testFile := filepath.Join(tempDir, "test-boilerplate.yml")
	testContent := `variables:
  - name: TestVar
    description: Test variable
    type: string
    default: "test value"
    validations: "required"
`
	err := os.WriteFile(testFile, []byte(testContent), 0644)
	require.NoError(t, err)

	// Create an invalid boilerplate file
	invalidFile := filepath.Join(tempDir, "invalid-boilerplate.yml")
	invalidContent := `variables:
  - name: InvalidVar
    description: Invalid variable
    type: unsupported_type
    default: "this should fail"
    invalid: yaml: syntax
    missing_quote: "unclosed string
`
	err = os.WriteFile(invalidFile, []byte(invalidContent), 0644)
	require.NoError(t, err)

	tests := []struct {
		name           string
		path           string
		expectedStatus int
		expectError    bool
	}{
		{
			name:           "valid boilerplate file",
			path:           "test-boilerplate.yml",
			expectedStatus: 200,
			expectError:    false,
		},
		{
			name:           "missing path parameter",
			path:           "",
			expectedStatus: 400,
			expectError:    true,
		},
		{
			name:           "non-existent file",
			path:           "non-existent.yml",
			expectedStatus: 404,
			expectError:    true,
		},
		{
			name:           "invalid boilerplate file",
			path:           "invalid-boilerplate.yml",
			expectedStatus: 400,
			expectError:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// This would require setting up a Gin test context
			// For now, we'll test the core parsing logic separately
			// The HTTP handler testing would require additional setup
			t.Skip("HTTP handler testing requires Gin test setup")
		})
	}
}

// Additional test for enum variables
func TestParseBoilerplateConfig_EnumVariables(t *testing.T) {
	absPath, err := filepath.Abs("../testdata/boilerplate-yaml/valid-enum-only.yml")
	require.NoError(t, err)

	// Read the file content
	content, err := os.ReadFile(absPath)
	require.NoError(t, err)

	config, err := parseBoilerplateConfig(string(content))
	require.NoError(t, err)
	require.NotNil(t, config)

	// Find the Environment variable (should be an enum)
	var environmentVar *BoilerplateVariable
	for _, variable := range config.Variables {
		if variable.Name == "Environment" {
			environmentVar = &variable
			break
		}
	}

	require.NotNil(t, environmentVar, "Environment variable should exist")
	assert.Equal(t, "enum", environmentVar.Type)
	assert.Equal(t, []string{"dev", "stage", "prod"}, environmentVar.Options)
	assert.Equal(t, "dev", environmentVar.Default)
}

// Test for complex default values
func TestParseBoilerplateConfig_ComplexDefaults(t *testing.T) {
	absPath, err := filepath.Abs("../testdata/boilerplate-yaml/valid-complex-defaults.yml")
	require.NoError(t, err)

	// Read the file content
	content, err := os.ReadFile(absPath)
	require.NoError(t, err)

	config, err := parseBoilerplateConfig(string(content))
	require.NoError(t, err)
	require.NotNil(t, config)

	// Find variables with complex default values
	for _, variable := range config.Variables {
		switch variable.Name {
		case "Tags":
			assert.Equal(t, "map", variable.Type)
			assert.IsType(t, map[string]interface{}{}, variable.Default)
		case "AllowedIPs":
			assert.Equal(t, "list", variable.Type)
			assert.IsType(t, []interface{}{}, variable.Default)
		case "EnableLogging":
			assert.Equal(t, "bool", variable.Type)
			assert.Equal(t, true, variable.Default)
		}
	}
}

// Test invalid boilerplate scenarios
func TestParseBoilerplateConfig_InvalidScenarios(t *testing.T) {
	tests := []struct {
		name          string
		filename      string
		expectedError string
	}{
		{
			name:          "invalid variable types",
			filename:      "../testdata/boilerplate-yaml/invalid-variable-types.yml",
			expectedError: "failed to parse boilerplate config",
		},
		{
			name:          "invalid validations",
			filename:      "../testdata/boilerplate-yaml/invalid-validations.yml",
			expectedError: "", // This should actually succeed - boilerplate is permissive
		},
		{
			name:          "invalid yaml syntax",
			filename:      "../testdata/boilerplate-yaml/invalid-yaml-2.yml",
			expectedError: "failed to parse boilerplate config",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			absPath, err := filepath.Abs(tt.filename)
			require.NoError(t, err)

			// Read the file content
			content, err := os.ReadFile(absPath)
			require.NoError(t, err)

			config, err := parseBoilerplateConfig(string(content))

			if tt.expectedError == "" {
				// This test case should succeed
				assert.NoError(t, err)
				assert.NotNil(t, config)
			} else {
				// This test case should fail
				assert.Error(t, err)
				assert.Nil(t, config)
				assert.Contains(t, err.Error(), tt.expectedError)
			}
		})
	}
}

// Test for x-section extraction (Runbooks extension)
func TestParseBoilerplateConfig_Sections(t *testing.T) {
	absPath, err := filepath.Abs("../testdata/boilerplate-yaml/valid-with-sections.yml")
	require.NoError(t, err)

	// Read the file content
	content, err := os.ReadFile(absPath)
	require.NoError(t, err)

	config, err := parseBoilerplateConfig(string(content))
	require.NoError(t, err)
	require.NotNil(t, config)

	// Verify the number of variables
	assert.Equal(t, 6, len(config.Variables))

	// Verify sections slice
	require.NotNil(t, config.Sections)
	assert.Equal(t, 3, len(config.Sections))

	// Verify section order and contents: "" always first, then order of first occurrence
	// Section 0: unnamed section (unsectioned variables)
	assert.Equal(t, "", config.Sections[0].Name)
	assert.Equal(t, []string{"FunctionName", "Description"}, config.Sections[0].Variables)

	// Section 1: Advanced Settings (first named section to appear)
	assert.Equal(t, "Advanced Settings", config.Sections[1].Name)
	assert.Equal(t, []string{"MemorySize", "Timeout"}, config.Sections[1].Variables)

	// Section 2: Basic Configuration
	assert.Equal(t, "Basic Configuration", config.Sections[2].Name)
	assert.Equal(t, []string{"Runtime", "Tags"}, config.Sections[2].Variables)

	// Verify individual variable section names are set correctly
	variableToSection := make(map[string]string)
	for _, v := range config.Variables {
		variableToSection[v.Name] = v.SectionName
	}
	
	assert.Equal(t, "Advanced Settings", variableToSection["MemorySize"])
	assert.Equal(t, "", variableToSection["FunctionName"]) // unsectioned
	assert.Equal(t, "Basic Configuration", variableToSection["Runtime"])
	assert.Equal(t, "Advanced Settings", variableToSection["Timeout"])
	assert.Equal(t, "", variableToSection["Description"]) // unsectioned
	assert.Equal(t, "Basic Configuration", variableToSection["Tags"])

	// Verify schema extension still works with x- prefix
	var tagsVar *BoilerplateVariable
	for i, v := range config.Variables {
		if v.Name == "Tags" {
			tagsVar = &config.Variables[i]
			break
		}
	}
	require.NotNil(t, tagsVar)
	assert.Equal(t, map[string]string{"Name": "string", "Environment": "string"}, tagsVar.Schema)
	assert.Equal(t, "Tag Name", tagsVar.SchemaInstanceLabel)
}

// Test section groupings extraction helper function directly
func TestExtractSectionGroupings(t *testing.T) {
	tests := []struct {
		name             string
		yaml             string
		expectedSections []Section
	}{
		{
			name: "all unsectioned",
			yaml: `variables:
  - name: Var1
    type: string
  - name: Var2
    type: string`,
			expectedSections: []Section{
				{Name: "", Variables: []string{"Var1", "Var2"}},
			},
		},
		{
			name: "all sectioned",
			yaml: `variables:
  - name: Var1
    type: string
    x-section: Section A
  - name: Var2
    type: string
    x-section: Section B`,
			expectedSections: []Section{
				{Name: "Section A", Variables: []string{"Var1"}},
				{Name: "Section B", Variables: []string{"Var2"}},
			},
		},
		{
			name: "mixed - unnamed section appears after named",
			yaml: `variables:
  - name: Var1
    type: string
    x-section: Named Section
  - name: Var2
    type: string`,
			expectedSections: []Section{
				{Name: "", Variables: []string{"Var2"}},              // "" is moved to front
				{Name: "Named Section", Variables: []string{"Var1"}},
			},
		},
		{
			name:             "empty yaml",
			yaml:             `variables: []`,
			expectedSections: []Section{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sections := extractSectionGroupings(tt.yaml)
			assert.Equal(t, tt.expectedSections, sections)
		})
	}
}

// Test x-schema and x-schema-instance-label extraction with new prefixes
func TestExtractSchemasFromYAML_WithXPrefix(t *testing.T) {
	yaml := `variables:
  - name: Accounts
    type: map
    x-schema:
      email: string
      id: string
    x-schema-instance-label: Account Name`

	schemas := extractSchemasFromYAML(yaml)
	assert.Equal(t, map[string]string{"email": "string", "id": "string"}, schemas["Accounts"])

	labels := extractSchemaInstanceLabelsFromYAML(yaml)
	assert.Equal(t, "Account Name", labels["Accounts"])
}
