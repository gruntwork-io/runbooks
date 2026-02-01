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
		{
			name: "command with shell redirection (> character)",
			content: `
<Command
    id="create-greeting"
    command='echo "Hello {{ .Name }}!" > greeting.txt'
    title="Create greeting"
/>
`,
			componentType: "Command",
			expectedCount: 1,
			expectedIDs:   []string{"create-greeting"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "command with shell redirection in other direction (< character)",
			content: `
<Command
    id="create-greeting2"
    command='echo "Hello {{ .Name }}!" < cat greeting.txt'
    title="Create greeting"
/>
`,
			componentType: "Command",
			expectedCount: 1,
			expectedIDs:   []string{"create-greeting2"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "command with multiple > characters in double quotes",
			content: `
<Command
    id="redirect-test"
    command="echo 'a > b > c' >> output.txt"
    title="Multiple redirects"
/>
`,
			componentType: "Command",
			expectedCount: 1,
			expectedIDs:   []string{"redirect-test"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "command with > in JSX expression",
			content: "<Command\n\tid=\"jsx-redirect\"\n\tcommand={`echo test > file.txt`}\n\ttitle=\"JSX redirect\"\n/>",
			componentType: "Command",
			expectedCount: 1,
			expectedIDs:   []string{"jsx-redirect"},
			expectedTypes: []ExecutableType{ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "skip components inside fenced code blocks",
			content: `
# Documentation

Here's a real command:

<Command id="real-cmd" command="echo real" />

Here's an example in a code block:

` + "```mdx" + `
<Command id="example-cmd" path="scripts/example.sh" />
` + "```" + `

And another real command:

<Command id="another-real" command="echo another" />
`,
			componentType: "Command",
			expectedCount: 2,
			expectedIDs:   []string{"real-cmd", "another-real"},
			expectedTypes: []ExecutableType{ExecutableTypeInline, ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "skip multiple components in fenced code blocks",
			content: `
<Command id="before" command="echo before" />

` + "```" + `
{/* Example 1 */}
<Command id="example-1" path="scripts/a.sh" />

{/* Example 2 */}
<Command id="example-2" path="scripts/b.sh" usePty={true} />

{/* Example 3 */}
<Command id="example-3" path="scripts/c.sh" usePty={false} />
` + "```" + `

<Command id="after" command="echo after" />
`,
			componentType: "Command",
			expectedCount: 2,
			expectedIDs:   []string{"before", "after"},
			expectedTypes: []ExecutableType{ExecutableTypeInline, ExecutableTypeInline},
			expectError:   false,
		},
		{
			name: "handle multiple code blocks",
			content: `
<Check id="real-1" command="echo 1" />

` + "```bash" + `
# Not a component
echo hello
` + "```" + `

` + "```mdx" + `
<Check id="fake-1" command="ignored" />
` + "```" + `

<Check id="real-2" command="echo 2" />

` + "```" + `
<Check id="fake-2" command="also ignored" />
` + "```" + `

<Check id="real-3" command="echo 3" />
`,
			componentType: "Check",
			expectedCount: 3,
			expectedIDs:   []string{"real-1", "real-2", "real-3"},
			expectedTypes: []ExecutableType{ExecutableTypeInline, ExecutableTypeInline, ExecutableTypeInline},
			expectError:   false,
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
			name:     "single quoted in braces",
			props:    `command={'echo "OpenTofu: $(mise ls-remote opentofu | tail -1)"'}`,
			propName: "command",
			expected: `echo "OpenTofu: $(mise ls-remote opentofu | tail -1)"`,
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
			result := ExtractProp(tt.props, tt.propName)
			if result != tt.expected {
				t.Errorf("Expected %q, got %q", tt.expected, result)
			}
		})
	}
}

func TestGenerateExecutableID(t *testing.T) {
	// Test that same inputs produce same ID
	id1 := computeExecutableID("component-1", "echo test")
	id2 := computeExecutableID("component-1", "echo test")
	
	if id1 != id2 {
		t.Errorf("Same inputs should produce same ID: %s != %s", id1, id2)
	}

	// Test that different inputs produce different IDs
	id3 := computeExecutableID("component-2", "echo test")
	if id1 == id3 {
		t.Errorf("Different component IDs should produce different executable IDs")
	}

	id4 := computeExecutableID("component-1", "echo different")
	if id1 == id4 {
		t.Errorf("Different content should produce different executable IDs")
	}

	// Test that ID is 16 characters (hex of 8 bytes)
	if len(id1) != 16 {
		t.Errorf("Expected ID length 16, got %d", len(id1))
	}
}

