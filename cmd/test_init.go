package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"runbooks/api/testing"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// testInitCmd represents the test init command
var testInitCmd = &cobra.Command{
	Use:   "init <runbook-path>",
	Short: "Initialize a test configuration for a runbook",
	Long: `Generate a runbook_test.yml file for a runbook based on its structure.

This command analyzes the runbook's MDX file to discover Check, Command, Template,
TemplateInline, Inputs, AwsAuth, and GitHubAuth blocks, then generates a test configuration
file with reasonable defaults.`,
	Args: cobra.ExactArgs(1),
	RunE: runTestInit,
}

func init() {
	testCmd.AddCommand(testInitCmd)
}

// runTestInit generates a test configuration for a runbook
func runTestInit(cmd *cobra.Command, args []string) error {
	runbookPath := args[0]

	// Handle directory or file path
	info, err := os.Stat(runbookPath)
	if err != nil {
		return fmt.Errorf("path not found: %s", runbookPath)
	}

	if info.IsDir() {
		runbookPath = filepath.Join(runbookPath, "runbook.mdx")
	}

	// Verify runbook exists
	if _, err := os.Stat(runbookPath); err != nil {
		return fmt.Errorf("runbook not found: %s", runbookPath)
	}

	dir := filepath.Dir(runbookPath)
	testConfigPath := filepath.Join(dir, "runbook_test.yml")

	// Check if file already exists (for messaging)
	_, existsErr := os.Stat(testConfigPath)
	fileExists := existsErr == nil

	// Parse runbook to find blocks
	blocks, err := parseRunbookBlocks(runbookPath)
	if err != nil {
		return fmt.Errorf("failed to parse runbook: %w", err)
	}

	// Generate test config
	config := generateTestConfig(filepath.Base(dir), blocks)

	// Write test config
	if err := os.WriteFile(testConfigPath, []byte(config), 0644); err != nil {
		return fmt.Errorf("failed to write test config: %w", err)
	}

	if fileExists {
		fmt.Printf("Overwrote %s\n", testConfigPath)
	} else {
		fmt.Printf("Created %s\n", testConfigPath)
	}
	fmt.Printf("Found %d blocks: %s\n", len(blocks), strings.Join(getBlockNames(blocks), ", "))
	fmt.Println("\nEdit the file to configure inputs and assertions for your tests.")

	return nil
}

// blockInfo holds information about a parsed block
type blockInfo struct {
	ID                 string
	Type               string // "Check", "Command", "Template", "TemplateInline"
	HasInputs          bool
	TemplatePath       string
	OutputPath         string             // For TemplateInline blocks
	InputsID           string             // For TemplateInline blocks - references an Inputs block
	Variables          []variableInfo     // Variables discovered for this inputs/template block
	OutputDependencies []outputDependency // Output dependencies for TemplateInline blocks
	Position           int                // Position in the document (for ordering)
}

// outputDependency represents a dependency on a block output
type outputDependency struct {
	BlockID    string
	OutputName string
}

// variableInfo holds information about a single variable
type variableInfo struct {
	Name        string
	Type        string
	Default     interface{}
	Options     []string // For enum types
	Validations []interface{}
	Schema      map[string]string // x-schema for nested map types
	// Parsed constraint values
	MinLength int
	MaxLength int
	Min       int
	Max       int
	IsEmail   bool
	IsURL     bool
	Required  bool
}

// boilerplateConfig represents a boilerplate.yml file structure
type boilerplateConfig struct {
	Variables []struct {
		Name        string            `yaml:"name"`
		Type        string            `yaml:"type"`
		Default     interface{}       `yaml:"default"`
		Options     []string          `yaml:"options"`
		Validations interface{}       `yaml:"validations"` // Can be string or slice
		XSchema     map[string]string `yaml:"x-schema"`    // Schema for nested map types
	} `yaml:"variables"`
}

// blockTagRegex generates a regex pattern to match an MDX block tag with its props.
// It handles quoted strings (double, single, and backtick) within props and matches
// both self-closing tags (</>) and opening tags (>).
// The returned regex has one capture group containing the props string.
// Note: For self-closing tags, the captured props may include a trailing "/".
// Use trimPropsSlash() to clean the captured props if needed.
func blockTagRegex(blockName string) *regexp.Regexp {
	// Pattern explanation:
	// - <BlockName\s+ - matches opening tag with required whitespace
	// - ([^>]*(?:"[^"]*"|'[^']*'|`[^`]*`|[^>])*) - captures props, handling quoted strings
	// - (?:/>|>) - matches either self-closing or opening tag end
	pattern := `<` + blockName + `\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*)(?:/>|>)`
	return regexp.MustCompile(pattern)
}

// trimPropsSlash removes a trailing "/" and surrounding whitespace from props captured from self-closing tags.
func trimPropsSlash(props string) string {
	props = strings.TrimRight(props, " \t\n")
	props = strings.TrimSuffix(props, "/")
	props = strings.TrimRight(props, " \t\n")
	return props
}

// blockTagSelfClosingRegex generates a regex pattern to match only self-closing MDX block tags.
// The returned regex has one capture group containing the props string.
// Note: The captured props may include a trailing "/". Use trimPropsSlash() to clean it.
func blockTagSelfClosingRegex(blockName string) *regexp.Regexp {
	pattern := `<` + blockName + `\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*?)/>`
	return regexp.MustCompile(pattern)
}

// blockTagContainerRegex generates a regex pattern to match container-style MDX block tags
// (opening tag with content and closing tag).
// The returned regex has two capture groups: (1) props string, (2) inner content.
func blockTagContainerRegex(blockName string) *regexp.Regexp {
	// Container tags end with > (not />), so we can use a simpler pattern for props
	pattern := `<` + blockName + `\s+([^>]*)>([\s\S]*?)</` + blockName + `>`
	return regexp.MustCompile(pattern)
}

// parseSimpleBlocks finds all occurrences of a block type and extracts basic info.
// Used for blocks that only need id extraction (Check, Command, AwsAuth, GitHubAuth).
func parseSimpleBlocks(contentStr, blockType string, seen map[string]bool) []blockInfo {
	var blocks []blockInfo
	re := blockTagRegex(blockType)
	for _, match := range re.FindAllStringSubmatchIndex(contentStr, -1) {
		if len(match) >= 4 {
			props := contentStr[match[2]:match[3]]
			id := extractPropValue(props, "id")
			if id != "" && !seen[id] {
				seen[id] = true
				blocks = append(blocks, blockInfo{
					ID:       id,
					Type:     blockType,
					Position: match[0],
				})
			}
		}
	}
	return blocks
}

// parseRunbookBlocks parses the runbook MDX file to find blocks
func parseRunbookBlocks(path string) ([]blockInfo, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	runbookDir := filepath.Dir(path)
	contentStr := string(content)
	var blocks []blockInfo
	seen := make(map[string]bool)

	// Parse simple blocks (only need id extraction)
	for _, blockType := range []string{"Check", "Command", "AwsAuth", "GitHubAuth"} {
		blocks = append(blocks, parseSimpleBlocks(contentStr, blockType, seen)...)
	}

	// Parse Template blocks and read their boilerplate.yml
	templateRe := blockTagRegex("Template")
	for _, match := range templateRe.FindAllStringSubmatchIndex(contentStr, -1) {
		if len(match) >= 4 {
			props := contentStr[match[2]:match[3]]
			id := extractPropValue(props, "id")
			templatePath := extractPropValue(props, "path")
			if id != "" && !seen[id] {
				seen[id] = true
				block := blockInfo{
					ID:           id,
					Type:         "Template",
					TemplatePath: templatePath,
					Position:     match[0],
				}
				// Try to read variables from boilerplate.yml
				if templatePath != "" {
					boilerplatePath := filepath.Join(runbookDir, templatePath, "boilerplate.yml")
					if vars, err := parseBoilerplateFile(boilerplatePath); err == nil {
						block.Variables = vars
						block.HasInputs = len(vars) > 0
					}
				}
				blocks = append(blocks, block)
			}
		}
	}

	// Parse Inputs blocks - both with path attribute and inline YAML
	// First, match Inputs with content (container form)
	inputsContainerRe := blockTagContainerRegex("Inputs")
	for _, match := range inputsContainerRe.FindAllStringSubmatchIndex(contentStr, -1) {
		if len(match) >= 6 {
			props := contentStr[match[2]:match[3]]
			innerContent := contentStr[match[4]:match[5]]
			id := extractPropValue(props, "id")
			inputsPath := extractPropValue(props, "path")

			if id != "" && !seen[id] {
				seen[id] = true
				block := blockInfo{
					ID:        id,
					Type:      "Inputs",
					HasInputs: true,
					Position:  match[0],
				}

				// Try to get variables from path or inline content
				if inputsPath != "" {
					// Read from path
					fullPath := filepath.Join(runbookDir, inputsPath)
					if vars, err := parseBoilerplateFile(fullPath); err == nil {
						block.Variables = vars
					}
				} else {
					// Parse inline YAML from content
					vars, err := parseInlineInputsYAML(innerContent)
					if err != nil {
						return nil, fmt.Errorf("error in Inputs block %q: %w", id, err)
					}
					if len(vars) > 0 {
						block.Variables = vars
					}
				}
				blocks = append(blocks, block)
			}
		}
	}

	// Parse self-closing Inputs with path
	inputsSelfClosingRe := blockTagSelfClosingRegex("Inputs")
	for _, match := range inputsSelfClosingRe.FindAllStringSubmatchIndex(contentStr, -1) {
		if len(match) >= 4 {
			props := contentStr[match[2]:match[3]]
			id := extractPropValue(props, "id")
			inputsPath := extractPropValue(props, "path")

			if id != "" && !seen[id] {
				seen[id] = true
				block := blockInfo{
					ID:        id,
					Type:      "Inputs",
					HasInputs: true,
					Position:  match[0],
				}

				if inputsPath != "" {
					fullPath := filepath.Join(runbookDir, inputsPath)
					if vars, err := parseBoilerplateFile(fullPath); err == nil {
						block.Variables = vars
					}
				}
				blocks = append(blocks, block)
			}
		}
	}

	// Parse TemplateInline blocks with their content
	// TemplateInline blocks don't have an id prop - we generate one from outputPath
	templateInlineWithContentRe := blockTagContainerRegex("TemplateInline")
	templateInlineCount := 0
	for _, match := range templateInlineWithContentRe.FindAllStringSubmatchIndex(contentStr, -1) {
		if len(match) >= 6 {
			props := contentStr[match[2]:match[3]]
			content := contentStr[match[4]:match[5]]
			outputPath := extractPropValue(props, "outputPath")
			inputsID := extractPropValue(props, "inputsId")

			// Generate ID from outputPath or use a counter
			id := testing.GenerateTemplateInlineID(outputPath)
			if id == "" {
				templateInlineCount++
				id = fmt.Sprintf("template-inline-%d", templateInlineCount)
			}

			if !seen[id] {
				seen[id] = true
				// Extract output dependencies from template content
				deps := extractOutputDependencies(content)
				blocks = append(blocks, blockInfo{
					ID:                 id,
					Type:               "TemplateInline",
					OutputPath:         outputPath,
					InputsID:           inputsID,
					OutputDependencies: deps,
					Position:           match[0],
				})
			}
		}
	}

	// Sort blocks by their position in the document
	sort.Slice(blocks, func(i, j int) bool {
		return blocks[i].Position < blocks[j].Position
	})

	return blocks, nil
}

// extractOutputDependencies extracts {{ ._blocks.blockId.outputs.outputName }} patterns from content
func extractOutputDependencies(content string) []outputDependency {
	// Match patterns like {{ ._blocks.list_users.outputs.users }}
	re := regexp.MustCompile(`\{\{\s*-?\s*(?:range\s+[^}]*)?\.?_blocks\.([a-zA-Z0-9_-]+)\.outputs\.(\w+)`)
	matches := re.FindAllStringSubmatch(content, -1)

	seen := make(map[string]bool)
	var deps []outputDependency

	for _, match := range matches {
		if len(match) >= 3 {
			blockID := match[1]
			outputName := match[2]
			key := blockID + "." + outputName

			if !seen[key] {
				seen[key] = true
				deps = append(deps, outputDependency{
					BlockID:    blockID,
					OutputName: outputName,
				})
			}
		}
	}

	return deps
}

// parseBoilerplateFile reads a boilerplate.yml file and extracts variable info
func parseBoilerplateFile(path string) ([]variableInfo, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var config boilerplateConfig
	if err := yaml.Unmarshal(content, &config); err != nil {
		return nil, err
	}

	var vars []variableInfo
	for _, v := range config.Variables {
		vi := variableInfo{
			Name:    v.Name,
			Type:    v.Type,
			Default: v.Default,
			Options: v.Options,
			Schema:  v.XSchema,
		}
		parseValidations(&vi, v.Validations)
		vars = append(vars, vi)
	}
	return vars, nil
}

// parseInlineInputsYAML extracts variables from inline YAML in an Inputs block
func parseInlineInputsYAML(content string) ([]variableInfo, error) {
	// Extract YAML from code fence if present
	yamlContent := content

	// Look for ```yaml ... ``` pattern
	codeFenceRe := regexp.MustCompile("(?s)```(?:yaml|yml)?\\s*\\n(.+?)```")
	if match := codeFenceRe.FindStringSubmatch(content); len(match) > 1 {
		yamlContent = match[1]
	}

	var config boilerplateConfig
	if err := yaml.Unmarshal([]byte(yamlContent), &config); err != nil {
		// Truncate content for error message if too long
		displayContent := yamlContent
		if len(displayContent) > 200 {
			displayContent = displayContent[:200] + "..."
		}
		return nil, fmt.Errorf("failed to parse inline YAML in Inputs block: %w\nYAML content:\n%s", err, displayContent)
	}

	var vars []variableInfo
	for _, v := range config.Variables {
		vi := variableInfo{
			Name:    v.Name,
			Type:    v.Type,
			Default: v.Default,
			Options: v.Options,
		}
		parseValidations(&vi, v.Validations)
		vars = append(vars, vi)
	}
	return vars, nil
}

// parseValidations extracts validation constraints from the validations field
func parseValidations(vi *variableInfo, validations interface{}) {
	if validations == nil {
		return
	}

	// Handle single string validation
	if s, ok := validations.(string); ok {
		applyValidation(vi, s)
		return
	}

	// Handle slice of validations
	if slice, ok := validations.([]interface{}); ok {
		for _, v := range slice {
			switch vv := v.(type) {
			case string:
				applyValidation(vi, vv)
			case map[string]interface{}:
				for key, value := range vv {
					applyValidationMap(vi, key, value)
				}
			case map[interface{}]interface{}:
				for key, value := range vv {
					if keyStr, ok := key.(string); ok {
						applyValidationMap(vi, keyStr, value)
					}
				}
			}
		}
	}
}

// applyValidation applies a string validation to variableInfo
func applyValidation(vi *variableInfo, validation string) {
	switch validation {
	case "required":
		vi.Required = true
	case "email":
		vi.IsEmail = true
	case "url":
		vi.IsURL = true
	}
}

// applyValidationMap applies a map-based validation to variableInfo
func applyValidationMap(vi *variableInfo, key string, value interface{}) {
	intVal := 0
	switch v := value.(type) {
	case int:
		intVal = v
	case int64:
		intVal = int(v)
	case float64:
		intVal = int(v)
	}

	switch key {
	case "minLength":
		vi.MinLength = intVal
	case "maxLength":
		vi.MaxLength = intVal
	case "min":
		vi.Min = intVal
	case "max":
		vi.Max = intVal
	}
}

// extractPropValue extracts a prop value from a props string
func extractPropValue(props, propName string) string {
	patterns := []string{
		fmt.Sprintf(`%s="([^"]*)"`, propName),
		fmt.Sprintf(`%s='([^']*)'`, propName),
		fmt.Sprintf(`%s=\{`+"`([^`]*)`"+`\}`, propName),
		fmt.Sprintf(`%s=\{"([^"]*)"\}`, propName),
		fmt.Sprintf(`%s=\{'([^']*)'\}`, propName),
	}

	for _, pattern := range patterns {
		re := regexp.MustCompile(pattern)
		if match := re.FindStringSubmatch(props); len(match) > 1 {
			return match[1]
		}
	}

	return ""
}

// getBlockNames returns block IDs for display
func getBlockNames(blocks []blockInfo) []string {
	var names []string
	for _, b := range blocks {
		names = append(names, b.ID)
	}
	return names
}

// generateTestConfig generates YAML test configuration
func generateTestConfig(runbookName string, blocks []blockInfo) string {
	var sb strings.Builder

	sb.WriteString("# Test configuration for ")
	sb.WriteString(runbookName)
	sb.WriteString("\n# Generated by: runbooks test init\n")
	sb.WriteString("# Edit this file to customize your tests.\n\n")

	sb.WriteString("version: 1\n\n")

	sb.WriteString("settings:\n")
	sb.WriteString("  # Generate files to a temp directory (cleaned up after test)\n")
	sb.WriteString("  use_temp_working_dir: true\n")
	sb.WriteString("  # Working directory for script execution (default: temp directory)\n")
	sb.WriteString("  # working_dir: \".\"  # Use \".\" for runbook directory, or specify a path\n")
	sb.WriteString("  # Test timeout\n")
	sb.WriteString("  timeout: 5m\n")
	sb.WriteString("  # Can this runbook's tests run in parallel with others?\n")
	sb.WriteString("  parallelizable: true\n\n")

	sb.WriteString("tests:\n")
	sb.WriteString("  - name: happy-path\n")
	sb.WriteString("    description: Standard successful execution\n\n")

	// Generate inputs section with all discovered variables
	hasInputs := false
	for _, b := range blocks {
		if (b.Type == "Inputs" || b.Type == "Template") && len(b.Variables) > 0 {
			hasInputs = true
			break
		}
	}

	if hasInputs {
		sb.WriteString("    inputs:\n")
		for _, b := range blocks {
			if len(b.Variables) > 0 {
				for _, v := range b.Variables {
					// Write comment with variable info
					sb.WriteString(fmt.Sprintf("      # %s: %s", v.Name, v.Type))
					if len(v.Options) > 0 {
						sb.WriteString(fmt.Sprintf(" [%s]", strings.Join(v.Options, ", ")))
					}
					if v.Required {
						sb.WriteString(", required")
					}
					sb.WriteString("\n")

					// Write the fuzz config
					sb.WriteString(fmt.Sprintf("      %s.%s:", b.ID, v.Name))
					fuzzConfig := formatFuzzConfig(v, "        ")
					sb.WriteString(fuzzConfig)
				}
			}
		}
		sb.WriteString("\n")
	}

	// Generate steps (executable blocks: Check, Command, Template, and TemplateInline)
	// All blocks are commented out by default so tests run all blocks in document order.
	// This ensures new blocks added to the runbook are automatically included in tests.
	sb.WriteString("    steps:\n")
	sb.WriteString("      # Note: Order matters! Blocks that produce outputs must run before\n")
	sb.WriteString("      # blocks that consume them via {{ ._blocks.x.outputs.y }}\n")
	sb.WriteString("      # All blocks below are commented out, so this test runs all blocks\n")
	sb.WriteString("      # in document order. Uncomment specific blocks to run only those.\n\n")

	for _, b := range blocks {
		switch b.Type {
		case "Check", "Command":
			sb.WriteString(fmt.Sprintf("      # - block: %s\n", b.ID))
			sb.WriteString("      #   expect: success\n\n")
		case "Template":
			sb.WriteString(fmt.Sprintf("      # - block: %s\n", b.ID))
			if b.TemplatePath != "" {
				sb.WriteString(fmt.Sprintf("      #   # Template: %s\n", b.TemplatePath))
			}
			sb.WriteString("      #   expect: success\n\n")
		case "TemplateInline":
			sb.WriteString(fmt.Sprintf("      # - block: %s\n", b.ID))
			if b.OutputPath != "" {
				sb.WriteString(fmt.Sprintf("      #   # Renders: %s\n", b.OutputPath))
			}
			if b.InputsID != "" {
				sb.WriteString(fmt.Sprintf("      #   # Uses inputs from: %s\n", b.InputsID))
			}
			if len(b.OutputDependencies) > 0 {
				deps := make([]string, 0, len(b.OutputDependencies))
				for _, dep := range b.OutputDependencies {
					deps = append(deps, fmt.Sprintf("%s.%s", dep.BlockID, dep.OutputName))
				}
				sb.WriteString(fmt.Sprintf("      #   # Depends on: %s\n", strings.Join(deps, ", ")))
			}
			sb.WriteString("      #   expect: success\n\n")
		case "AwsAuth":
			sb.WriteString(fmt.Sprintf("      # - block: %s\n", b.ID))
			sb.WriteString("      #   # Set expect: skip if not testing AWS auth\n")
			sb.WriteString("      #   # Or ensure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set\n")
			sb.WriteString("      #   expect: skip\n\n")
		case "GitHubAuth":
			sb.WriteString(fmt.Sprintf("      # - block: %s\n", b.ID))
			sb.WriteString("      #   # Set expect: skip if not testing GitHub auth\n")
			sb.WriteString("      #   # Or set RUNBOOKS_GITHUB_TOKEN env var\n")
			sb.WriteString("      #   expect: skip\n\n")
		// Inputs blocks are not executable, so don't add them to steps
		}
	}

	// Generate assertions section
	sb.WriteString("    assertions:\n")
	sb.WriteString("      # TemplateInline blocks automatically validate their output dependencies.\n")
	sb.WriteString("      # Add additional assertions to validate test results:\n")
	sb.WriteString("      # - type: file_exists\n")
	sb.WriteString("      #   path: generated/README.md\n")
	sb.WriteString("      # - type: file_contains\n")
	sb.WriteString("      #   path: generated/README.md\n")
	sb.WriteString("      #   contains: \"expected content\"\n")

	// Add commented files_generated assertion if there are templates
	// (Template blocks can't be executed headlessly yet)
	for _, b := range blocks {
		if b.Type == "Template" {
			sb.WriteString("      # - type: files_generated\n")
			sb.WriteString(fmt.Sprintf("      #   block: %s\n", b.ID))
			sb.WriteString("      #   min_count: 1\n")
			break
		}
	}

	sb.WriteString("\n")

	// Generate cleanup section
	sb.WriteString("    # cleanup:\n")
	sb.WriteString("    #   - command: rm -rf /tmp/test-resources\n")
	sb.WriteString("    #   - path: cleanup/teardown.sh\n")

	return sb.String()
}

// formatFuzzConfig generates a fuzz configuration YAML for a variable
func formatFuzzConfig(v variableInfo, indent string) string {
	var sb strings.Builder

	// Determine fuzz type based on variable type and validations
	fuzzType := determineFuzzType(v)

	// For maps with x-schema, pass the schema fields so fuzz generator can create nested maps
	if fuzzType == "map" && len(v.Schema) > 0 {
		sb.WriteString("\n")
		sb.WriteString(indent)
		sb.WriteString("fuzz:\n")
		sb.WriteString(indent)
		sb.WriteString("  type: map\n")
		sb.WriteString(indent)
		sb.WriteString("  minCount: 2\n")
		sb.WriteString(indent)
		sb.WriteString("  maxCount: 4\n")
		sb.WriteString(indent)
		sb.WriteString("  schema:\n")
		// Get sorted field names for consistent output
		var fields []string
		for field := range v.Schema {
			fields = append(fields, field)
		}
		sort.Strings(fields)
		for _, field := range fields {
			sb.WriteString(indent)
			sb.WriteString(fmt.Sprintf("    - %s\n", field))
		}
		return sb.String()
	}

	sb.WriteString("\n")
	sb.WriteString(indent)
	sb.WriteString("fuzz:\n")
	sb.WriteString(indent)
	sb.WriteString(fmt.Sprintf("  type: %s\n", fuzzType))

	switch fuzzType {
	case "enum":
		sb.WriteString(indent)
		// Quote options to handle empty strings and special characters
		quotedOpts := make([]string, len(v.Options))
		for i, opt := range v.Options {
			quotedOpts[i] = fmt.Sprintf("%q", opt)
		}
		sb.WriteString(fmt.Sprintf("  options: [%s]\n", strings.Join(quotedOpts, ", ")))

	case "string":
		// Add length constraints if present
		if v.MinLength > 0 {
			sb.WriteString(indent)
			sb.WriteString(fmt.Sprintf("  minLength: %d\n", v.MinLength))
		}
		if v.MaxLength > 0 {
			sb.WriteString(indent)
			sb.WriteString(fmt.Sprintf("  maxLength: %d\n", v.MaxLength))
		}
		// If no constraints, add reasonable defaults
		if v.MinLength == 0 && v.MaxLength == 0 {
			sb.WriteString(indent)
			sb.WriteString("  minLength: 5\n")
			sb.WriteString(indent)
			sb.WriteString("  maxLength: 20\n")
		}

	case "int":
		if v.Min > 0 || v.Max > 0 {
			if v.Min > 0 {
				sb.WriteString(indent)
				sb.WriteString(fmt.Sprintf("  min: %d\n", v.Min))
			}
			if v.Max > 0 {
				sb.WriteString(indent)
				sb.WriteString(fmt.Sprintf("  max: %d\n", v.Max))
			}
		} else {
			sb.WriteString(indent)
			sb.WriteString("  min: 1\n")
			sb.WriteString(indent)
			sb.WriteString("  max: 100\n")
		}

	case "email":
		sb.WriteString(indent)
		sb.WriteString("  domain: example.com\n")

	case "url":
		sb.WriteString(indent)
		sb.WriteString("  domain: example.com\n")

	case "list":
		sb.WriteString(indent)
		sb.WriteString("  minCount: 2\n")
		sb.WriteString(indent)
		sb.WriteString("  maxCount: 4\n")

	case "map":
		sb.WriteString(indent)
		sb.WriteString("  minCount: 2\n")
		sb.WriteString(indent)
		sb.WriteString("  maxCount: 4\n")
	}

	return sb.String()
}

// determineFuzzType determines the appropriate fuzz type for a variable
func determineFuzzType(v variableInfo) string {
	// Check validations first - they take precedence
	if v.IsEmail {
		return "email"
	}
	if v.IsURL {
		return "url"
	}

	// Then check variable type
	switch v.Type {
	case "enum":
		return "enum"
	case "int":
		return "int"
	case "float":
		return "float"
	case "bool":
		return "bool"
	case "list":
		return "list"
	case "map":
		return "map"
	default:
		return "string"
	}
}
