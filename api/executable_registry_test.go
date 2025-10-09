package api

import (
	"path/filepath"
	"testing"
)

func TestParseComponents(t *testing.T) {
	tests := []struct {
		name           string
		content        string
		componentType  string
		expectedCount  int
		expectedIDs    []string
		expectedTypes  []ExecutableType
		expectError    bool
	}{
		{
			name: "parse single Check with inline command",
			content: `
# Test Runbook

<Check
	id="check-git"
	command="git --version"
	title="Check Git"
/>
`,
			componentType: "Check",
			expectedCount: 1,
			expectedIDs:   []string{"check-git"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "parse single Command with inline command",
			content: `
<Command
	id="run-test"
	command="echo hello"
	title="Say Hello"
/>
`,
			componentType: "Command",
			expectedCount: 1,
			expectedIDs:   []string{"run-test"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "parse Check with boilerplate variables",
			content: `
<Check
	id="check-env"
	command="echo {{ .Name }}"
	title="Check Environment"
	boilerplateInputsId="user-vars"
/>
`,
			componentType: "Check",
			expectedCount: 1,
			expectedIDs:   []string{"check-env"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "parse multiple components",
			content: `
# Multi-Check Runbook

<Check
	id="check-1"
	command="ls -la"
	title="First Check"
/>

Some text in between

<Check
	id="check-2"
	command="pwd"
	title="Second Check"
/>
`,
			componentType: "Check",
			expectedCount: 2,
			expectedIDs:   []string{"check-1", "check-2"},
			expectedTypes: []ExecutableType{ExecutableTypeInline, ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "parse Check with children (inline BoilerplateInputs)",
			content: `
<Check
	id="check-with-inputs"
	command="echo {{ .Value }}"
	title="Check with Inputs"
>
	<BoilerplateInputs id="inline-inputs">
		variables:
		  - name: Value
	</BoilerplateInputs>
</Check>
`,
			componentType: "Check",
			expectedCount: 1,
			expectedIDs:   []string{"check-with-inputs"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "parse self-closing component",
			content: `
<Check id="self-closing" command="echo test" />
`,
			componentType: "Check",
			expectedCount: 1,
			expectedIDs:   []string{"self-closing"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "parse component with multiline command",
			content: "<Command\n\tid=\"multi-line\"\n\tcommand={`#!/bin/bash\n\techo test`}\n\ttitle=\"Multi-line Command\"\n/>",
			componentType: "Command",
			expectedCount: 1,
			expectedIDs:   []string{"multi-line"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "no components",
			content: `
# Just a regular markdown file
No components here!
`,
			componentType: "Check",
			expectedCount: 0,
			expectedIDs:   []string{},
			expectedTypes: []ExecutableType{},
			expectError:   false,
		},
		{
			name: "component without id generates one",
			content: `
<Check command="echo test" title="No ID" />
`,
			componentType: "Check",
			expectedCount: 1,
			// ID will be generated, so we just check count
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create a temporary directory for the test
			tmpDir := t.TempDir()

			// Create registry
			registry := &ExecutableRegistry{
				runbookPath: filepath.Join(tmpDir, "runbook.mdx"),
				executables: make(map[string]*Executable),
			}

			// Parse components
			err := registry.parseComponents(tt.content, tmpDir, tt.componentType)

			// Check for unexpected errors
			if (err != nil) != tt.expectError {
				t.Errorf("parseComponents() error = %v, expectError %v", err, tt.expectError)
				return
			}

			// Check count
			if len(registry.executables) != tt.expectedCount {
				t.Errorf("Expected %d executables, got %d", tt.expectedCount, len(registry.executables))
				return
			}

			// Check component IDs and types
			foundIDs := make(map[string]bool)
			for _, exec := range registry.executables {
				foundIDs[exec.ComponentID] = true

				// Check component type matches
				expectedType := "check"
				if tt.componentType == "Command" {
					expectedType = "command"
				}
				if exec.ComponentType != expectedType {
					t.Errorf("Expected component type %s, got %s", expectedType, exec.ComponentType)
				}

				// Find which expected ID this is and check type
				for i, expectedID := range tt.expectedIDs {
					if exec.ComponentID == expectedID {
						if i < len(tt.expectedTypes) && exec.Type != tt.expectedTypes[i] {
							t.Errorf("Expected type %s for component %s, got %s", 
								tt.expectedTypes[i], expectedID, exec.Type)
						}
					}
				}
			}

			// Verify all expected IDs were found
			for _, expectedID := range tt.expectedIDs {
				if !foundIDs[expectedID] {
					t.Errorf("Expected component ID %s not found", expectedID)
				}
			}
		})
	}
}

func TestExtractTemplateVars(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		expected []string
	}{
		{
			name:     "no variables",
			content:  "echo hello world",
			expected: []string{},
		},
		{
			name:     "single variable",
			content:  "echo {{.Name}}",
			expected: []string{"Name"},
		},
		{
			name:     "multiple variables",
			content:  "echo {{.First}} {{.Last}}",
			expected: []string{"First", "Last"},
		},
		{
			name:     "variables with spaces",
			content:  "echo {{ .Name }} {{ .Value }}",
			expected: []string{"Name", "Value"},
		},
		{
			name:     "duplicate variables",
			content:  "{{.Name}} and {{.Name}} again",
			expected: []string{"Name"},
		},
		{
			name:     "mixed content",
			content:  "#!/bin/bash\necho {{.User}}\nls -la\ncat {{.File}}",
			expected: []string{"User", "File"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := extractTemplateVars(tt.content)

			if len(result) != len(tt.expected) {
				t.Errorf("Expected %d variables, got %d: %v", len(tt.expected), len(result), result)
				return
			}

			// Convert to map for easy comparison (order doesn't matter)
			resultMap := make(map[string]bool)
			for _, v := range result {
				resultMap[v] = true
			}

			for _, expectedVar := range tt.expected {
				if !resultMap[expectedVar] {
					t.Errorf("Expected variable %s not found in result: %v", expectedVar, result)
				}
			}
		})
	}
}

func TestExtractProp(t *testing.T) {
	tests := []struct {
		name     string
		props    string
		propName string
		expected string
	}{
		{
			name:     "double quoted value",
			props:    `id="test-123" title="Test Title"`,
			propName: "id",
			expected: "test-123",
		},
		{
			name:     "single quoted value",
			props:    `id='test-456' title='Test'`,
			propName: "id",
			expected: "test-456",
		},
		{
			name:     "template literal",
			props:    "command={`echo hello`}",
			propName: "command",
			expected: "echo hello",
		},
		{
			name:     "double quoted in braces",
			props:    `command={"echo test"}`,
			propName: "command",
			expected: "echo test",
		},
		{
			name:     "prop not found",
			props:    `id="test" title="Test"`,
			propName: "description",
			expected: "",
		},
		{
			name:     "multiline props",
			props:    "id=\"multi\"\n\tcommand=\"echo test\"\n\ttitle=\"Title\"",
			propName: "command",
			expected: "echo test",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := extractProp(tt.props, tt.propName)
			if result != tt.expected {
				t.Errorf("Expected %q, got %q", tt.expected, result)
			}
		})
	}
}

func TestGenerateExecutableID(t *testing.T) {
	// Test that same inputs produce same ID
	id1 := generateExecutableID("component-1", "echo test")
	id2 := generateExecutableID("component-1", "echo test")
	
	if id1 != id2 {
		t.Errorf("Same inputs should produce same ID: %s != %s", id1, id2)
	}

	// Test that different inputs produce different IDs
	id3 := generateExecutableID("component-2", "echo test")
	if id1 == id3 {
		t.Errorf("Different component IDs should produce different executable IDs")
	}

	id4 := generateExecutableID("component-1", "echo different")
	if id1 == id4 {
		t.Errorf("Different content should produce different executable IDs")
	}

	// Test that ID is 16 characters (hex of 8 bytes)
	if len(id1) != 16 {
		t.Errorf("Expected ID length 16, got %d", len(id1))
	}
}

