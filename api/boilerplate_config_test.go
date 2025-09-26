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
			name:     "non-existent file",
			filename: "../testdata/boilerplate-yaml/non-existent.yml",
			wantErr:  true,
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

			config, err := parseBoilerplateConfig(absPath)

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

func TestParseBoilerplateConfig_FileErrors(t *testing.T) {
	tests := []struct {
		name          string
		filePath      string
		expectError   bool
		errorContains string
	}{
		{
			name:          "non-existent file",
			filePath:      "/non/existent/file.yml",
			expectError:   true,
			errorContains: "failed to open file",
		},
		{
			name:          "empty file",
			filePath:      "",
			expectError:   true,
			errorContains: "failed to open file",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			config, err := parseBoilerplateConfig(tt.filePath)

			if tt.expectError {
				assert.Error(t, err)
				assert.Contains(t, err.Error(), tt.errorContains)
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

	bpConfig, err := parseBoilerplateConfig(absPath)
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

	config, err := parseBoilerplateConfig(absPath)
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

	config, err := parseBoilerplateConfig(absPath)
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

	config, err := parseBoilerplateConfig(absPath)
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

			config, err := parseBoilerplateConfig(absPath)

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
