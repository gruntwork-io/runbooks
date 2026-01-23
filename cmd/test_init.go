package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// testInitCmd represents the test init command
var testInitCmd = &cobra.Command{
	Use:   "init <runbook-path>",
	Short: "Initialize a test configuration for a runbook",
	Long: `Generate a runbook_test.yml file for a runbook based on its structure.

This command analyzes the runbook's MDX file to discover Check, Command, and
Template blocks, then generates a test configuration file with reasonable defaults.`,
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

	// Check if test config already exists
	dir := filepath.Dir(runbookPath)
	testConfigPath := filepath.Join(dir, "runbook_test.yml")
	if _, err := os.Stat(testConfigPath); err == nil {
		return fmt.Errorf("runbook_test.yml already exists in %s", dir)
	}

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

	fmt.Printf("Created %s\n", testConfigPath)
	fmt.Printf("Found %d blocks: %s\n", len(blocks), strings.Join(getBlockNames(blocks), ", "))
	fmt.Println("\nEdit the file to configure inputs and assertions for your tests.")

	return nil
}

// blockInfo holds information about a parsed block
type blockInfo struct {
	ID            string
	Type          string // "Check", "Command", "Template"
	HasInputs     bool
	TemplatePath  string
	Variables     []variableInfo // Variables discovered for this inputs/template block
}

// variableInfo holds information about a single variable
type variableInfo struct {
	Name        string
	Type        string
	Default     interface{}
	Options     []string // For enum types
	Validations []interface{}
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
		Name        string        `yaml:"name"`
		Type        string        `yaml:"type"`
		Default     interface{}   `yaml:"default"`
		Options     []string      `yaml:"options"`
		Validations interface{}   `yaml:"validations"` // Can be string or slice
	} `yaml:"variables"`
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

	// Parse Check blocks
	checkRe := regexp.MustCompile(`<Check\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*)(?:/>|>)`)
	for _, match := range checkRe.FindAllStringSubmatch(contentStr, -1) {
		id := extractPropValue(match[1], "id")
		if id != "" && !seen[id] {
			seen[id] = true
			blocks = append(blocks, blockInfo{
				ID:   id,
				Type: "Check",
			})
		}
	}

	// Parse Command blocks
	cmdRe := regexp.MustCompile(`<Command\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*)(?:/>|>)`)
	for _, match := range cmdRe.FindAllStringSubmatch(contentStr, -1) {
		id := extractPropValue(match[1], "id")
		if id != "" && !seen[id] {
			seen[id] = true
			blocks = append(blocks, blockInfo{
				ID:   id,
				Type: "Command",
			})
		}
	}

	// Parse Template blocks and read their boilerplate.yml
	templateRe := regexp.MustCompile(`<Template\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*)(?:/>|>)`)
	for _, match := range templateRe.FindAllStringSubmatch(contentStr, -1) {
		id := extractPropValue(match[1], "id")
		templatePath := extractPropValue(match[1], "path")
		if id != "" && !seen[id] {
			seen[id] = true
			block := blockInfo{
				ID:           id,
				Type:         "Template",
				TemplatePath: templatePath,
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

	// Parse Inputs blocks - both with path attribute and inline YAML
	// First, match Inputs with content (container form)
	inputsContainerRe := regexp.MustCompile(`<Inputs\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*?)>([\s\S]*?)</Inputs>`)
	for _, match := range inputsContainerRe.FindAllStringSubmatch(contentStr, -1) {
		props := match[1]
		innerContent := match[2]
		id := extractPropValue(props, "id")
		inputsPath := extractPropValue(props, "path")

		if id != "" && !seen[id] {
			seen[id] = true
			block := blockInfo{
				ID:        id,
				Type:      "Inputs",
				HasInputs: true,
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
				if vars := parseInlineInputsYAML(innerContent); len(vars) > 0 {
					block.Variables = vars
				}
			}
			blocks = append(blocks, block)
		}
	}

	// Parse self-closing Inputs with path
	inputsSelfClosingRe := regexp.MustCompile(`<Inputs\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*?)/>`)
	for _, match := range inputsSelfClosingRe.FindAllStringSubmatch(contentStr, -1) {
		props := match[1]
		id := extractPropValue(props, "id")
		inputsPath := extractPropValue(props, "path")

		if id != "" && !seen[id] {
			seen[id] = true
			block := blockInfo{
				ID:        id,
				Type:      "Inputs",
				HasInputs: true,
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

	// Parse AwsAuth blocks
	awsAuthRe := regexp.MustCompile(`<AwsAuth\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*)(?:/>|>)`)
	for _, match := range awsAuthRe.FindAllStringSubmatch(contentStr, -1) {
		id := extractPropValue(match[1], "id")
		if id != "" && !seen[id] {
			seen[id] = true
			blocks = append(blocks, blockInfo{
				ID:   id,
				Type: "AwsAuth",
			})
		}
	}

	return blocks, nil
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
		}
		parseValidations(&vi, v.Validations)
		vars = append(vars, vi)
	}
	return vars, nil
}

// parseInlineInputsYAML extracts variables from inline YAML in an Inputs block
func parseInlineInputsYAML(content string) []variableInfo {
	// Extract YAML from code fence if present
	yamlContent := content

	// Look for ```yaml ... ``` pattern
	codeFenceRe := regexp.MustCompile("(?s)```(?:yaml|yml)?\\s*\\n(.+?)```")
	if match := codeFenceRe.FindStringSubmatch(content); len(match) > 1 {
		yamlContent = match[1]
	}

	var config boilerplateConfig
	if err := yaml.Unmarshal([]byte(yamlContent), &config); err != nil {
		return nil
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
	return vars
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
	sb.WriteString("  use_temp_output: true\n")
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

	// Generate steps (only for executable blocks: Check and Command)
	sb.WriteString("    steps:\n")
	for _, b := range blocks {
		switch b.Type {
		case "Check", "Command":
			sb.WriteString(fmt.Sprintf("      - block: %s\n", b.ID))
			sb.WriteString("        expect: success\n\n")
		case "AwsAuth":
			sb.WriteString(fmt.Sprintf("      - block: %s\n", b.ID))
			sb.WriteString("        # Set expect: skip if not testing AWS auth\n")
			sb.WriteString("        # Or ensure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set\n")
			sb.WriteString("        expect: skip\n\n")
		// Template and Inputs blocks are not executable, so don't add them to steps
		}
	}

	// Generate assertions section
	sb.WriteString("    assertions:\n")
	sb.WriteString("      # Add assertions to validate test results\n")
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

	sb.WriteString("\n")
	sb.WriteString(indent)
	sb.WriteString("fuzz:\n")
	sb.WriteString(indent)
	sb.WriteString(fmt.Sprintf("  type: %s\n", fuzzType))

	switch fuzzType {
	case "enum":
		sb.WriteString(indent)
		sb.WriteString(fmt.Sprintf("  options: [%s]\n", strings.Join(v.Options, ", ")))

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
		return "string" // Default to string for lists
	case "map":
		return "string" // Default to string for maps
	default:
		return "string"
	}
}
