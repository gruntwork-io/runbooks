package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseRunbookBlocks_DocumentOrder(t *testing.T) {
	// Create a test MDX file with blocks in a specific order
	content := `# Test Runbook

<Check id="check-1" path="check1.sh" title="First check" />

<Command id="cmd-1" command="echo hello" title="First command" />

<Check id="check-2" path="check2.sh" title="Second check" />

<Command id="cmd-2" command="echo world" title="Second command" />
`
	dir := t.TempDir()
	runbookPath := filepath.Join(dir, "runbook.mdx")
	if err := os.WriteFile(runbookPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	blocks, err := parseRunbookBlocks(runbookPath)
	if err != nil {
		t.Fatalf("parseRunbookBlocks failed: %v", err)
	}

	// Verify document order is preserved
	expectedOrder := []string{"check-1", "cmd-1", "check-2", "cmd-2"}
	if len(blocks) != len(expectedOrder) {
		t.Fatalf("expected %d blocks, got %d", len(expectedOrder), len(blocks))
	}

	for i, expected := range expectedOrder {
		if blocks[i].ID != expected {
			t.Errorf("block %d: expected ID %q, got %q", i, expected, blocks[i].ID)
		}
	}
}

func TestParseRunbookBlocks_NoDuplicates(t *testing.T) {
	// Create a test MDX file where the same ID could potentially be matched twice
	content := `# Test Runbook

<Command id="my-command"
    command="echo test"
    title="My Command"
>
    <Inputs id="my-inputs">
` + "```yaml\n" + `variables:
- name: Name
  type: string
` + "```\n" + `    </Inputs>
</Command>

<Check id="my-check"
    command="echo check"
    inputsId="my-inputs"
    title="My Check"
/>
`
	dir := t.TempDir()
	runbookPath := filepath.Join(dir, "runbook.mdx")
	if err := os.WriteFile(runbookPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	blocks, err := parseRunbookBlocks(runbookPath)
	if err != nil {
		t.Fatalf("parseRunbookBlocks failed: %v", err)
	}

	// Count occurrences of each ID
	idCounts := make(map[string]int)
	for _, b := range blocks {
		idCounts[b.ID]++
	}

	// Verify no duplicates
	for id, count := range idCounts {
		if count > 1 {
			t.Errorf("block ID %q appears %d times, expected 1", id, count)
		}
	}

	// Should have 3 blocks: my-command, my-inputs, my-check
	expectedIDs := []string{"my-command", "my-inputs", "my-check"}
	if len(blocks) != len(expectedIDs) {
		t.Errorf("expected %d blocks, got %d: %v", len(expectedIDs), len(blocks), getBlockIDs(blocks))
	}
}

func TestParseRunbookBlocks_NestedInputsOrder(t *testing.T) {
	// Test that nested Inputs blocks appear in document order (after the opening tag of parent)
	content := `# Test Runbook

<Command id="parent-command"
    command="echo {{ .Name }}"
    title="Parent Command"
>
    <Inputs id="nested-inputs">
` + "```yaml\n" + `variables:
- name: Name
  type: string
` + "```\n" + `    </Inputs>
</Command>

<Check id="after-check" path="check.sh" title="After check" />
`
	dir := t.TempDir()
	runbookPath := filepath.Join(dir, "runbook.mdx")
	if err := os.WriteFile(runbookPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	blocks, err := parseRunbookBlocks(runbookPath)
	if err != nil {
		t.Fatalf("parseRunbookBlocks failed: %v", err)
	}

	// The order should be: parent-command, nested-inputs, after-check
	// because nested-inputs appears inside parent-command in the document
	expectedOrder := []string{"parent-command", "nested-inputs", "after-check"}
	if len(blocks) != len(expectedOrder) {
		t.Fatalf("expected %d blocks, got %d: %v", len(expectedOrder), len(blocks), getBlockIDs(blocks))
	}

	for i, expected := range expectedOrder {
		if blocks[i].ID != expected {
			t.Errorf("block %d: expected ID %q, got %q", i, expected, blocks[i].ID)
		}
	}
}

func TestGenerateTestConfig_StepsInDocumentOrder(t *testing.T) {
	// Create blocks in document order
	blocks := []blockInfo{
		{ID: "check-1", Type: "Check", Position: 100},
		{ID: "cmd-1", Type: "Command", Position: 200},
		{ID: "inputs-1", Type: "Inputs", Position: 250, Variables: []variableInfo{{Name: "Var1", Type: "string"}}},
		{ID: "check-2", Type: "Check", Position: 300},
		{ID: "template-1", Type: "Template", Position: 400},
		{ID: "cmd-2", Type: "Command", Position: 500},
	}

	config := generateTestConfig("test-runbook", blocks)

	// Verify executable blocks appear in steps in correct order
	// (Inputs blocks are not executable, so they shouldn't appear in steps)
	// (Template blocks ARE now included in steps for testing)
	// Note: Steps are commented out by default, so we look for "# - block:" pattern
	lines := strings.Split(config, "\n")
	var stepBlocks []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "# - block:") {
			id := strings.TrimPrefix(line, "# - block:")
			id = strings.TrimSpace(id)
			stepBlocks = append(stepBlocks, id)
		}
	}

	expectedSteps := []string{"check-1", "cmd-1", "check-2", "template-1", "cmd-2"}
	if len(stepBlocks) != len(expectedSteps) {
		t.Fatalf("expected %d step blocks, got %d: %v", len(expectedSteps), len(stepBlocks), stepBlocks)
	}

	for i, expected := range expectedSteps {
		if stepBlocks[i] != expected {
			t.Errorf("step %d: expected %q, got %q", i, expected, stepBlocks[i])
		}
	}
}

func TestGenerateTestConfig_InputsInDocumentOrder(t *testing.T) {
	// Create blocks with variables - they should appear in document order in the inputs section
	blocks := []blockInfo{
		{ID: "check-1", Type: "Check", Position: 100},
		{ID: "inputs-b", Type: "Inputs", Position: 150, Variables: []variableInfo{{Name: "VarB", Type: "string"}}},
		{ID: "cmd-1", Type: "Command", Position: 200},
		{ID: "inputs-a", Type: "Inputs", Position: 250, Variables: []variableInfo{{Name: "VarA", Type: "string"}}},
		{ID: "template-1", Type: "Template", Position: 300, Variables: []variableInfo{{Name: "VarT", Type: "string"}}},
	}

	config := generateTestConfig("test-runbook", blocks)

	// Find the order of input block IDs in the generated config
	var inputOrder []string
	lines := strings.Split(config, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		// Lines like "inputs-b.VarB:" indicate the order
		for _, b := range blocks {
			if len(b.Variables) > 0 {
				prefix := b.ID + "."
				if strings.HasPrefix(line, prefix) && !strings.HasPrefix(line, "#") {
					// Only add if not already in list
					found := false
					for _, id := range inputOrder {
						if id == b.ID {
							found = true
							break
						}
					}
					if !found {
						inputOrder = append(inputOrder, b.ID)
					}
				}
			}
		}
	}

	// Inputs should appear in document order: inputs-b, inputs-a, template-1
	expectedInputOrder := []string{"inputs-b", "inputs-a", "template-1"}
	if len(inputOrder) != len(expectedInputOrder) {
		t.Fatalf("expected %d input blocks, got %d: %v", len(expectedInputOrder), len(inputOrder), inputOrder)
	}

	for i, expected := range expectedInputOrder {
		if inputOrder[i] != expected {
			t.Errorf("input order %d: expected %q, got %q", i, expected, inputOrder[i])
		}
	}
}

func TestParseRunbookBlocks_RealWorldDemo2(t *testing.T) {
	// Test with the actual demo2 runbook if it exists
	runbookPath := "testdata/sample-runbooks/demo2/runbook.mdx"
	
	// Try relative path from workspace root
	if _, err := os.Stat(runbookPath); os.IsNotExist(err) {
		// Try from parent directory (when running from cmd/)
		runbookPath = "../testdata/sample-runbooks/demo2/runbook.mdx"
	}
	
	if _, err := os.Stat(runbookPath); os.IsNotExist(err) {
		t.Skip("demo2 not found, skipping real-world test")
	}

	blocks, err := parseRunbookBlocks(runbookPath)
	if err != nil {
		t.Fatalf("parseRunbookBlocks failed: %v", err)
	}

	// Verify no duplicates
	idCounts := make(map[string]int)
	for _, b := range blocks {
		idCounts[b.ID]++
	}

	for id, count := range idCounts {
		if count > 1 {
			t.Errorf("block ID %q appears %d times, expected 1", id, count)
		}
	}

	// Verify expected document order for key blocks
	blockIDs := getBlockIDs(blocks)
	
	// check-gh-install should come before install-gh-latest-version
	checkGHIdx := indexOf(blockIDs, "check-gh-install")
	installGHIdx := indexOf(blockIDs, "install-gh-latest-version")
	if checkGHIdx == -1 || installGHIdx == -1 {
		t.Error("expected check-gh-install and install-gh-latest-version to be present")
	} else if checkGHIdx > installGHIdx {
		t.Errorf("check-gh-install (idx %d) should come before install-gh-latest-version (idx %d)", checkGHIdx, installGHIdx)
	}

	// install-gh-latest-version should come before check-mise-install
	checkMiseIdx := indexOf(blockIDs, "check-mise-install")
	if installGHIdx == -1 || checkMiseIdx == -1 {
		t.Error("expected install-gh-latest-version and check-mise-install to be present")
	} else if installGHIdx > checkMiseIdx {
		t.Errorf("install-gh-latest-version (idx %d) should come before check-mise-install (idx %d)", installGHIdx, checkMiseIdx)
	}

	// create-infrastructure-live-root-repo should come before infrastructure-live-root-repo-inputs
	createRepoIdx := indexOf(blockIDs, "create-infrastructure-live-root-repo")
	inputsIdx := indexOf(blockIDs, "infrastructure-live-root-repo-inputs")
	if createRepoIdx == -1 || inputsIdx == -1 {
		t.Error("expected create-infrastructure-live-root-repo and infrastructure-live-root-repo-inputs to be present")
	} else if createRepoIdx > inputsIdx {
		t.Errorf("create-infrastructure-live-root-repo (idx %d) should come before infrastructure-live-root-repo-inputs (idx %d)", createRepoIdx, inputsIdx)
	}

	t.Logf("Block order: %v", blockIDs)
}

func TestBlockTagRegex(t *testing.T) {
	tests := []struct {
		name      string
		blockName string
		input     string
		wantMatch bool
		wantProps string
	}{
		{
			name:      "self-closing tag with double quotes",
			blockName: "Check",
			input:     `<Check id="my-check" path="check.sh" />`,
			wantMatch: true,
			wantProps: `id="my-check" path="check.sh"`,
		},
		{
			name:      "self-closing tag with single quotes",
			blockName: "Command",
			input:     `<Command id='my-cmd' command='echo hello' />`,
			wantMatch: true,
			wantProps: `id='my-cmd' command='echo hello'`,
		},
		{
			name:      "self-closing tag with backtick quotes",
			blockName: "Command",
			input:     "<Command id=\"test\" command={`echo hello`} />",
			wantMatch: true,
			wantProps: "id=\"test\" command={`echo hello`}",
		},
		{
			name:      "opening tag (not self-closing)",
			blockName: "Inputs",
			input:     `<Inputs id="my-inputs">content here</Inputs>`,
			wantMatch: true,
			wantProps: `id="my-inputs"`,
		},
		{
			name:      "verbose empty container form",
			blockName: "Command",
			input:     `<Command id="verbose-cmd" command="echo test"></Command>`,
			wantMatch: true,
			wantProps: `id="verbose-cmd" command="echo test"`,
		},
		{
			name:      "multiline props",
			blockName: "Command",
			input: `<Command
    id="multi-line"
    command="echo test"
    title="Test"
/>`,
			wantMatch: true,
			wantProps: `id="multi-line"
    command="echo test"
    title="Test"`,
		},
		{
			name:      "no match for different block name",
			blockName: "Check",
			input:     `<Command id="my-cmd" />`,
			wantMatch: false,
		},
		{
			name:      "no match without whitespace after tag name",
			blockName: "Check",
			input:     `<Checkbox id="test" />`,
			wantMatch: false,
		},
		{
			name:      "AwsAuth block",
			blockName: "AwsAuth",
			input:     `<AwsAuth id="aws-creds" region="us-east-1" />`,
			wantMatch: true,
			wantProps: `id="aws-creds" region="us-east-1"`,
		},
		{
			name:      "GitHubAuth block",
			blockName: "GitHubAuth",
			input:     `<GitHubAuth id="gh-auth" scopes={["repo", "read:org"]} />`,
			wantMatch: true,
			wantProps: `id="gh-auth" scopes={["repo", "read:org"]}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			re := blockTagRegex(tt.blockName)
			matches := re.FindStringSubmatch(tt.input)

			if tt.wantMatch {
				if matches == nil {
					t.Errorf("expected match but got none")
					return
				}
				if len(matches) < 2 {
					t.Errorf("expected capture group but got %d groups", len(matches))
					return
				}
				// Use trimPropsSlash to clean the captured props (removes trailing / from self-closing tags)
				gotProps := trimPropsSlash(matches[1])
				if gotProps != tt.wantProps {
					t.Errorf("props mismatch:\n  got:  %q\n  want: %q", gotProps, tt.wantProps)
				}
			} else {
				if matches != nil {
					t.Errorf("expected no match but got: %v", matches)
				}
			}
		})
	}
}

func TestTrimPropsSlash(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{`id="test" /`, `id="test"`},
		{`id="test"`, `id="test"`},
		{`id="test" `, `id="test"`},
		{`id="test" 
/`, `id="test"`},
		{`path="/some/path" /`, `path="/some/path"`}, // slash in value should be preserved
	}

	for _, tt := range tests {
		got := trimPropsSlash(tt.input)
		if got != tt.want {
			t.Errorf("trimPropsSlash(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestBlockTagSelfClosingRegex(t *testing.T) {
	tests := []struct {
		name      string
		blockName string
		input     string
		wantMatch bool
		wantProps string
	}{
		{
			name:      "matches self-closing tag",
			blockName: "Inputs",
			input:     `<Inputs id="test" path="inputs.yml" />`,
			wantMatch: true,
			wantProps: `id="test" path="inputs.yml"`,
		},
		{
			name:      "does not match opening tag",
			blockName: "Inputs",
			input:     `<Inputs id="test">content</Inputs>`,
			wantMatch: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			re := blockTagSelfClosingRegex(tt.blockName)
			matches := re.FindStringSubmatch(tt.input)

			if tt.wantMatch {
				if matches == nil {
					t.Errorf("expected match but got none")
					return
				}
				if len(matches) < 2 {
					t.Errorf("expected capture group but got %d groups", len(matches))
					return
				}
				// Use trimPropsSlash to clean the captured props
				gotProps := trimPropsSlash(matches[1])
				if gotProps != tt.wantProps {
					t.Errorf("props mismatch:\n  got:  %q\n  want: %q", gotProps, tt.wantProps)
				}
			} else {
				if matches != nil {
					t.Errorf("expected no match but got: %v", matches)
				}
			}
		})
	}
}

func TestBlockTagContainerRegex(t *testing.T) {
	tests := []struct {
		name        string
		blockName   string
		input       string
		wantMatch   bool
		wantProps   string
		wantContent string
	}{
		{
			name:        "matches container tag with content",
			blockName:   "Inputs",
			input:       "<Inputs id=\"test\">\n```yaml\nvariables:\n- name: Foo\n```\n</Inputs>",
			wantMatch:   true,
			wantProps:   `id="test"`,
			wantContent: "\n```yaml\nvariables:\n- name: Foo\n```\n",
		},
		{
			name:        "matches TemplateInline with template content",
			blockName:   "TemplateInline",
			input:       `<TemplateInline outputPath="output.txt" inputsId="my-inputs">Hello {{ .Name }}</TemplateInline>`,
			wantMatch:   true,
			wantProps:   `outputPath="output.txt" inputsId="my-inputs"`,
			wantContent: `Hello {{ .Name }}`,
		},
		{
			name:      "does not match self-closing tag",
			blockName: "Inputs",
			input:     `<Inputs id="test" />`,
			wantMatch: false,
		},
		{
			name:      "does not match mismatched closing tag",
			blockName: "Inputs",
			input:     `<Inputs id="test">content</Command>`,
			wantMatch: false,
		},
		{
			name:        "multiline content",
			blockName:   "TemplateInline",
			input: `<TemplateInline outputPath="readme.md">
# README

This is a {{ .ProjectName }} project.

## Features
{{ range .Features }}
- {{ . }}
{{ end }}
</TemplateInline>`,
			wantMatch:   true,
			wantProps:   `outputPath="readme.md"`,
			wantContent: "\n# README\n\nThis is a {{ .ProjectName }} project.\n\n## Features\n{{ range .Features }}\n- {{ . }}\n{{ end }}\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			re := blockTagContainerRegex(tt.blockName)
			matches := re.FindStringSubmatch(tt.input)

			if tt.wantMatch {
				if matches == nil {
					t.Errorf("expected match but got none")
					return
				}
				if len(matches) < 3 {
					t.Errorf("expected 2 capture groups but got %d groups", len(matches)-1)
					return
				}
				if matches[1] != tt.wantProps {
					t.Errorf("props mismatch:\n  got:  %q\n  want: %q", matches[1], tt.wantProps)
				}
				if matches[2] != tt.wantContent {
					t.Errorf("content mismatch:\n  got:  %q\n  want: %q", matches[2], tt.wantContent)
				}
			} else {
				if matches != nil {
					t.Errorf("expected no match but got: %v", matches)
				}
			}
		})
	}
}

// Helper functions

func getBlockIDs(blocks []blockInfo) []string {
	ids := make([]string, len(blocks))
	for i, b := range blocks {
		ids[i] = b.ID
	}
	return ids
}

func indexOf(slice []string, item string) int {
	for i, s := range slice {
		if s == item {
			return i
		}
	}
	return -1
}
