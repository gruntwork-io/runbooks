package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	bpConfig "github.com/gruntwork-io/boilerplate/config"
	bpVariables "github.com/gruntwork-io/boilerplate/variables"
	"gopkg.in/yaml.v3"
)

// normalizeBlockID converts a block ID to its canonical form by replacing
// hyphens with underscores. This normalization is required because Go templates
// don't support hyphens in dot notation (e.g., ._blocks.create-account fails).
//
// This function must be used consistently across both frontend and backend:
// - Frontend: when registering/looking up outputs (RunbookContext)
// - Frontend: when checking output dependencies (Template, TemplateInline)
// - Backend: when extracting output dependencies from templates
//
// Example: "create-account" → "create_account"
func normalizeBlockID(id string) string {
	return strings.ReplaceAll(id, "-", "_")
}

// ResolveBoilerplatePath resolves a template path to the template directory and
// the full boilerplate.yml path. The path prop in <Inputs> and <Template> can be
// either a directory containing a boilerplate.yml file, or a direct path to the
// boilerplate.yml file itself.
//
// Example with directory path: ResolveBoilerplatePath("/runbooks/my-runbook", "templates/vpc")
// returns ("/runbooks/my-runbook/templates/vpc", "/runbooks/my-runbook/templates/vpc/boilerplate.yml")
//
// Example with file path: ResolveBoilerplatePath("/runbooks/my-runbook", "templates/vpc/boilerplate.yml")
// returns ("/runbooks/my-runbook/templates/vpc", "/runbooks/my-runbook/templates/vpc/boilerplate.yml")
func ResolveBoilerplatePath(runbookDir, templatePath string) (templateDir, boilerplatePath string) {
	// Check if the path already points to a boilerplate config file
	if strings.HasSuffix(templatePath, "boilerplate.yml") || strings.HasSuffix(templatePath, "boilerplate.yaml") {
		boilerplatePath = filepath.Join(runbookDir, templatePath)
		templateDir = filepath.Dir(boilerplatePath)
		return
	}
	// Otherwise, treat as directory and append boilerplate.yml
	templateDir = filepath.Join(runbookDir, templatePath)
	boilerplatePath = filepath.Join(templateDir, "boilerplate.yml")
	return
}

// This handler takes a path to a boilerplate.yml file and returns the variable declarations as JSON.
//
// There's a design decision here on how much of Boilerplate's native packages to use to parse the boilerplate.yml file,
// versus re-implementing simpler versions in this file. Our big boilerplate function in this file is bpConfig.ParseBoilerplateConfig,
// but we define our own versions of the following:
// - BoilerplateVariable (simplified)
// - BoilerplateValidationType (repeated)
// - ValidationRule (simplified)
// - extractValidations, determineValidationType, isVariableRequired (repeated)
//
// We want to leverage as much from Boilerplate as possible, so ideally, in the future we could expose a public function
// in the Boilerplate package to replace our repeated ones here.
//
// Also note that Boilerplate has a TON of indirect dependencies that we don't need; our two humble boilerplate imports
// above bring in 100+ indirect dependencies!
// TODO: We should update Boilerplate to fix this.
// ---

// BoilerplateVariable represents a single variable from boilerplate.yml

// HandleBoilerplateRequest parses a boilerplate.yml file and returns the variable declarations as JSON
// @runbookPath is the path to the boilerplate template, relative to the directory containing the runbook file.
func HandleBoilerplateRequest(runbookPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Parse the request body
		var req BoilerplateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid request body",
				"details": err.Error(),
			})
			return
		}

		// Validate that either templatePath or boilerplateContent is provided
		if req.TemplatePath == "" && req.BoilerplateContent == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "Either templatePath or boilerplateContent must be provided",
			})
			return
		}

		var content string
		var err error
		var templateDir string // Track the template directory for output dependency scanning

		if req.TemplatePath != "" {
			// Extract the directory from the runbookPath (which we assume is a file path)
			runbookDir := filepath.Dir(runbookPath)

			// Resolve the template directory and boilerplate.yml path
			var fullPath string
			templateDir, fullPath = ResolveBoilerplatePath(runbookDir, req.TemplatePath)
			slog.Info("Looking for boilerplate file", "fullPath", fullPath)

			// Check if the file exists
			if _, err := os.Stat(fullPath); os.IsNotExist(err) {
				slog.Error("File not found", "path", fullPath)
				c.JSON(http.StatusNotFound, gin.H{
					"error":   "boilerplate.yml file not found",
					"details": "Tried to load: " + fullPath,
				})
				return
			}

			// Read the file contents
			fileContent, err := os.ReadFile(fullPath)
			if err != nil {
				slog.Error("Error reading boilerplate file", "error", err)
				c.JSON(http.StatusInternalServerError, gin.H{
					"error":   "Failed to read boilerplate file",
					"details": err.Error(),
				})
				return
			}
			content = string(fileContent)
			slog.Info("Parsing boilerplate config from file", "fullPath", fullPath)
		} else {
			// Use the provided boilerplate content directly
			content = req.BoilerplateContent
			slog.Info("Parsing boilerplate config from request body")
		}

	// Parse the boilerplate.yml file using the gruntwork-io/boilerplate package
	config, err := parseBoilerplateConfig(content)
	if err != nil {
		slog.Error("Error parsing boilerplate config", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Invalid boilerplate configuration",
			"details": err.Error(),
		})
		return
	}

	// If we have a template directory, scan for output dependencies in template files
	if templateDir != "" {
		outputDeps, err := extractOutputDependenciesFromTemplateDir(templateDir)
		if err != nil {
			// Log warning but don't fail - output dependency scanning is best-effort
			slog.Warn("Failed to extract output dependencies from template directory", "templateDir", templateDir, "error", err)
		} else if len(outputDeps) > 0 {
			config.OutputDependencies = outputDeps
			slog.Info("Found output dependencies in template files", "count", len(outputDeps), "dependencies", outputDeps)
		}
	}

	slog.Info("Successfully parsed boilerplate config", "variableCount", len(config.Variables), "outputDepCount", len(config.OutputDependencies))
	// Return the parsed configuration
	c.JSON(http.StatusOK, config)
	}
}

// parseBoilerplateConfig parses a boilerplate.yml file and returns the variable definitions
func parseBoilerplateConfig(boilerplateYamlContent string) (*BoilerplateConfig, error) {
	// Parse the boilerplate configuration
	boilerplateConfig, err := bpConfig.ParseBoilerplateConfig([]byte(boilerplateYamlContent))
	if err != nil {
		return nil, fmt.Errorf("failed to parse boilerplate config: %w", err)
	}

	slog.Info("Boilerplate config parsed successfully", "variableCount", len(boilerplateConfig.Variables))

	// Parse raw YAML once to extract all Runbooks x- extension fields
	rawVars := parseRawXVariables(boilerplateYamlContent)
	schemas, schemaInstanceLabels, variableToSection := extractXFields(rawVars)
	sections := extractSectionGroupings(boilerplateYamlContent)

	// Convert to our JSON structure
	result := &BoilerplateConfig{
		Variables: make([]BoilerplateVariable, 0, len(boilerplateConfig.Variables)),
		Sections:  sections,
	}

	// Extract raw validation strings from YAML (catches validations the boilerplate library doesn't understand)
	rawValidations := extractValidationsFromYAML(boilerplateYamlContent)

	for _, variable := range boilerplateConfig.Variables {
		// Convert default value to JSON-serializable format
		defaultValue := convertToJSONSerializable(variable.Default())

		// Extract validations from the boilerplate library's parsed rules
		validations := extractValidations(variable.Validations())
		isRequired := isVariableRequired(variable.Validations())

		// Merge in any validations from raw YAML that the boilerplate library didn't parse
		// (e.g., regex(...) patterns that boilerplate doesn't natively support)
		if rawRules, exists := rawValidations[variable.Name()]; exists {
			validations, isRequired = mergeRawValidations(validations, isRequired, rawRules)
		}

		slog.Debug("Variable validation info", "name", variable.Name(), "validationCount", len(variable.Validations()), "required", isRequired)

		// Use the variable type as-is (no fallback since we enforce strict schema adherence)
		variableType := BoilerplateVarType(variable.Type())

		boilerplateVar := BoilerplateVariable{
			Name:        variable.Name(),
			Description: variable.Description(),
			Type:        variableType,
			Default:     defaultValue,
			Required:    isRequired,
			Validations: validations,
		}

		// Handle enum type options
		if variable.Type() == bpVariables.Enum {
			boilerplateVar.Options = variable.Options()
		}

		// Attach schema if available
		if schema, exists := schemas[variable.Name()]; exists {
			boilerplateVar.Schema = schema
		}

		// Attach schema instance label if available
		if schemaInstanceLabel, exists := schemaInstanceLabels[variable.Name()]; exists {
			boilerplateVar.SchemaInstanceLabel = schemaInstanceLabel
		}

		// Attach section name if available
		if sectionName, exists := variableToSection[variable.Name()]; exists {
			boilerplateVar.SectionName = sectionName
		}

		result.Variables = append(result.Variables, boilerplateVar)
	}

	return result, nil
}

// rawXVariable holds all Runbooks-specific x- extensions from boilerplate.yml.
// A single struct avoids re-parsing YAML multiple times for different fields.
type rawXVariable struct {
	Name                string            `yaml:"name"`
	Schema              map[string]string `yaml:"x-schema"`
	SchemaInstanceLabel string            `yaml:"x-schema-instance-label"`
	Section             string            `yaml:"x-section"`
}

// parseRawXVariables parses the raw YAML once and returns the x-extension fields.
func parseRawXVariables(yamlContent string) []rawXVariable {
	type rawConfig struct {
		Variables []rawXVariable `yaml:"variables"`
	}
	var config rawConfig
	if err := yaml.Unmarshal([]byte(yamlContent), &config); err != nil {
		slog.Warn("Failed to parse YAML for x-field extraction", "error", err)
		return nil
	}
	return config.Variables
}

// extractXFields extracts all x- extension fields from pre-parsed raw variables in a single pass.
// Returns schemas, schema instance labels, and variable-to-section mappings.
func extractXFields(rawVars []rawXVariable) (
	schemas map[string]map[string]string,
	schemaInstanceLabels map[string]string,
	variableToSection map[string]string,
) {
	schemas = make(map[string]map[string]string)
	schemaInstanceLabels = make(map[string]string)
	variableToSection = make(map[string]string)

	for _, v := range rawVars {
		if len(v.Schema) > 0 {
			schemas[v.Name] = v.Schema
		}
		if v.SchemaInstanceLabel != "" {
			schemaInstanceLabels[v.Name] = v.SchemaInstanceLabel
		}
		if v.Section != "" {
			variableToSection[v.Name] = v.Section
		}
	}
	return
}

// extractSchemasFromYAML returns a map of variable name to schema (field name -> type).
// YAML property: x-schema (Runbooks extension, ignored by Boilerplate)
func extractSchemasFromYAML(yamlContent string) map[string]map[string]string {
	schemas, _, _ := extractXFields(parseRawXVariables(yamlContent))
	return schemas
}

// extractSchemaInstanceLabelsFromYAML returns a map of variable name to schema instance label.
// YAML property: x-schema-instance-label (Runbooks extension, ignored by Boilerplate)
func extractSchemaInstanceLabelsFromYAML(yamlContent string) map[string]string {
	_, labels, _ := extractXFields(parseRawXVariables(yamlContent))
	return labels
}

// extractVariablesToSectionMap returns a map of variable name -> section name.
// YAML property: x-section (Runbooks extension, ignored by Boilerplate)
func extractVariablesToSectionMap(yamlContent string) map[string]string {
	_, _, sections := extractXFields(parseRawXVariables(yamlContent))
	return sections
}

// extractSectionGroupings parses the raw YAML to build an ordered list of section groupings.
// Returns an ordered slice of Section structs for UI rendering (e.g., rendering collapsible sections).
// Each Section contains the section name and the list of variable names in that section.
// Variables without a section use "" (empty string) as the section name.
// The unnamed section ("") is always placed first if it exists.
// YAML property: x-section (Runbooks extension, ignored by Boilerplate)
func extractSectionGroupings(yamlContent string) []Section {
	type rawVariable struct {
		Name    string `yaml:"name"`
		Section string `yaml:"x-section"`
	}
	type rawConfig struct {
		Variables []rawVariable `yaml:"variables"`
	}

	var config rawConfig
	if err := yaml.Unmarshal([]byte(yamlContent), &config); err != nil {
		slog.Warn("Failed to parse YAML for x-section extraction", "error", err)
		return []Section{}
	}

	return groupIntoSections(config.Variables, func(v rawVariable) (string, string) {
		return v.Name, v.Section
	})
}

// groupIntoSections collects items into ordered sections, with the unnamed
// section ("") always placed first. extractFn returns (variableName, sectionName).
func groupIntoSections[T any](items []T, extractFn func(T) (string, string)) []Section {
	sectionVars := make(map[string][]string)
	var sectionOrder []string
	seen := make(map[string]bool)

	for _, item := range items {
		varName, sectionName := extractFn(item)
		sectionVars[sectionName] = append(sectionVars[sectionName], varName)
		if !seen[sectionName] {
			seen[sectionName] = true
			sectionOrder = append(sectionOrder, sectionName)
		}
	}

	// Ensure "" is first
	if seen[""] && len(sectionOrder) > 0 && sectionOrder[0] != "" {
		newOrder := []string{""}
		for _, s := range sectionOrder {
			if s != "" {
				newOrder = append(newOrder, s)
			}
		}
		sectionOrder = newOrder
	}

	sections := make([]Section, 0, len(sectionOrder))
	for _, name := range sectionOrder {
		sections = append(sections, Section{
			Name:      name,
			Variables: sectionVars[name],
		})
	}
	return sections
}

// extractValidationsFromYAML parses the raw YAML to extract validation strings for variables.
// This catches validations that the boilerplate library doesn't natively understand (e.g., regex patterns).
// Supports both YAML formats that boilerplate accepts:
//
//	validations: "required url"          # string format (space-delimited)
//	validations:                          # list format
//	  - required
//	  - "regex(^[a-z]+$)"
//
// Returns a map of variable name to a list of parsed ValidationRules.
func extractValidationsFromYAML(yamlContent string) map[string][]ValidationRule {
	type rawVariable struct {
		Name        string      `yaml:"name"`
		Validations interface{} `yaml:"validations"`
	}
	type rawConfig struct {
		Variables []rawVariable `yaml:"variables"`
	}

	var config rawConfig
	if err := yaml.Unmarshal([]byte(yamlContent), &config); err != nil {
		slog.Warn("Failed to parse YAML for validation extraction", "error", err)
		return map[string][]ValidationRule{}
	}

	result := make(map[string][]ValidationRule)
	for _, variable := range config.Variables {
		if variable.Validations == nil {
			continue
		}

		var rules []ValidationRule

		switch v := variable.Validations.(type) {
		case string:
			// String format: "required url" or "required regex(^[a-z]+$)"
			if v != "" {
				rules = parseValidationString(v)
			}
		case []interface{}:
			// List format: ["required", "regex(^[a-z]+$)"]
			for _, item := range v {
				if s, ok := item.(string); ok && s != "" {
					// Each list item is a single rule — parse it individually
					itemRules := parseValidationString(s)
					rules = append(rules, itemRules...)
				}
			}
		}

		if len(rules) > 0 {
			result[variable.Name] = rules
		}
	}

	return result
}

// validationTokenRe splits a validation string into tokens, respecting parenthesized arguments.
// Handles both space-delimited (boilerplate native) and comma-delimited (legacy) formats.
// Also matches length-min-max format (e.g., "length-3-50").
// e.g., "required regex(^vpc-[0-9a-f]{8,17}$)" → ["required", "regex(^vpc-[0-9a-f]{8,17}$)"]
var validationTokenRe = regexp.MustCompile(`([a-zA-Z]+(?:-\d+-\d+|\([^)]*\))?)`)

// parseValidationString parses a validation string into ValidationRules.
// Supports both space-delimited (boilerplate native) and comma-delimited formats.
// Understands: required, regex(pattern), length-min-max, length(min,max), url, email, alpha, digit, alphanumeric, semver, countrycode2.
func parseValidationString(s string) []ValidationRule {
	tokens := validationTokenRe.FindAllString(s, -1)
	var rules []ValidationRule

	for _, token := range tokens {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}

		switch {
		case token == "required":
			rules = append(rules, ValidationRule{Type: ValidationRequired, Message: "This field is required"})
		case strings.HasPrefix(token, "regex(") && strings.HasSuffix(token, ")"):
			pattern := token[6 : len(token)-1]
			rules = append(rules, ValidationRule{Type: ValidationRegex, Args: []interface{}{pattern}})
		// Boilerplate native format: length-min-max (e.g., "length-3-50")
		case strings.HasPrefix(token, "length-"):
			inner := token[7:]
			parts := strings.SplitN(inner, "-", 2)
			if len(parts) == 2 {
				rules = append(rules, ValidationRule{
					Type: ValidationLength,
					Args: []interface{}{strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])},
				})
			}
		// Legacy format: length(min,max) (e.g., "length(3,50)")
		case strings.HasPrefix(token, "length(") && strings.HasSuffix(token, ")"):
			inner := token[7 : len(token)-1]
			parts := strings.SplitN(inner, ",", 2)
			if len(parts) == 2 {
				rules = append(rules, ValidationRule{
					Type: ValidationLength,
					Args: []interface{}{strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])},
				})
			}
		case token == "url":
			rules = append(rules, ValidationRule{Type: ValidationURL})
		case token == "email":
			rules = append(rules, ValidationRule{Type: ValidationEmail})
		case token == "alpha":
			rules = append(rules, ValidationRule{Type: ValidationAlpha})
		case token == "digit":
			rules = append(rules, ValidationRule{Type: ValidationDigit})
		case token == "alphanumeric":
			rules = append(rules, ValidationRule{Type: ValidationAlphanumeric})
		case token == "semver":
			rules = append(rules, ValidationRule{Type: ValidationSemver})
		case token == "countrycode2":
			rules = append(rules, ValidationRule{Type: ValidationCountryCode2})
		}
	}

	return rules
}

// mergeRawValidations merges raw YAML-extracted validations with those from the boilerplate library.
// Raw validations fill in gaps where the boilerplate library doesn't support certain validation types.
// When a raw rule has Args (e.g., regex pattern) and the existing one doesn't, the raw rule replaces it.
// Returns the merged validations and the updated isRequired flag.
func mergeRawValidations(existing []ValidationRule, isRequired bool, rawRules []ValidationRule) ([]ValidationRule, bool) {
	// Build a map of existing validation types for deduplication, tracking index
	existingByType := make(map[BoilerplateValidationType]int)
	for i, r := range existing {
		existingByType[r.Type] = i
	}

	for _, raw := range rawRules {
		if raw.Type == ValidationRequired {
			isRequired = true
			// Only add if not already present
			if _, exists := existingByType[ValidationRequired]; !exists {
				existing = append([]ValidationRule{raw}, existing...)
				// Shift all indices by 1 since we prepended
				for k, v := range existingByType {
					existingByType[k] = v + 1
				}
				existingByType[ValidationRequired] = 0
			}
			continue
		}

		if idx, exists := existingByType[raw.Type]; exists {
			// If the raw rule has Args but the existing one doesn't, replace it
			// (e.g., boilerplate parsed regex into MatchRule but we need the pattern string)
			if len(raw.Args) > 0 && len(existing[idx].Args) == 0 {
				existing[idx] = raw
			}
		} else {
			// Add new rule type
			existingByType[raw.Type] = len(existing)
			existing = append(existing, raw)
		}
	}

	return existing, isRequired
}

// Unfortunately, Boilerplate doesn't expose its validation functions. So we use the same Library that Boilerplate
// uses to validate the variables to extract the validation rules. The better approach here is to update Boilerplate
// to expose the validation functions directly.
// TODO: Update Boilerplate to expose the validation functions directly.
//
// extractValidations converts boilerplate validation rules to our JSON format
// This function maps boilerplate's CustomValidationRule to our ValidationRule format
// by inspecting the actual ozzo-validation rules used by boilerplate
func extractValidations(validationRules []bpVariables.CustomValidationRule) []ValidationRule {
	validations := make([]ValidationRule, 0, len(validationRules))

	for _, rule := range validationRules {
		validation := ValidationRule{
			Message: rule.DescriptionText(),
		}

		// Determine validation type by inspecting the ozzo-validation rule
		validationType := determineValidationType(rule)
		validation.Type = validationType

		validations = append(validations, validation)
	}

	return validations
}

// Unfortunately, Boilerplate doesn't expose its validation functions. So we use the same Library that Boilerplate
// uses to validate the variables to extract the validation rules. The better approach here is to update Boilerplate
// to expose the validation functions directly.
// TODO: Update Boilerplate to expose the validation functions directly.
//
// determineValidationType inspects a CustomValidationRule to determine its type
// This uses reflection to examine the underlying ozzo-validation rule
func determineValidationType(rule bpVariables.CustomValidationRule) BoilerplateValidationType {
	// Get the underlying ozzo-validation rule
	validator := rule.Validator

	// Use reflection to determine the type of validator
	validatorType := fmt.Sprintf("%T", validator)

	// If Boilerplate adds a new validation type, add it here!
	switch {
	case strings.Contains(validatorType, "required"):
		return ValidationRequired
	case strings.Contains(validatorType, "MatchRule"):
		return ValidationRegex
	case strings.Contains(validatorType, "StringRule"):
		// For StringRule, we need to check the message to determine the specific validation type
		message := rule.DescriptionText()
		switch {
		case strings.Contains(strings.ToLower(message), "email"):
			return ValidationEmail
		case strings.Contains(strings.ToLower(message), "url"):
			return ValidationURL
		case strings.Contains(strings.ToLower(message), "alpha"):
			return ValidationAlpha
		case strings.Contains(strings.ToLower(message), "digit"):
			return ValidationDigit
		case strings.Contains(strings.ToLower(message), "alphanumeric"):
			return ValidationAlphanumeric
		case strings.Contains(strings.ToLower(message), "country"):
			return ValidationCountryCode2
		case strings.Contains(strings.ToLower(message), "semver"):
			return ValidationSemver
		case strings.Contains(strings.ToLower(message), "length"):
			return ValidationLength
		default:
			return ValidationCustom
		}
	default:
		return ValidationCustom
	}
}

// isVariableRequired determines if a variable is required based on its validation rules
func isVariableRequired(validationRules []bpVariables.CustomValidationRule) bool {
	for _, rule := range validationRules {
		// Use the same reflection approach to check if this is a Required validator
		validatorType := fmt.Sprintf("%T", rule.Validator)
		if strings.Contains(validatorType, "required") {
			return true
		}
	}
	return false
}

// convertToJSONSerializable converts YAML-parsed values  (e.g. the default value of a variable) to JSON-serializable format
func convertToJSONSerializable(value interface{}) interface{} {
	switch v := value.(type) {
	case map[interface{}]interface{}:
		// Convert map[interface{}]interface{} to map[string]interface{}
		result := make(map[string]interface{})
		for k, val := range v {
			if keyStr, ok := k.(string); ok {
				result[keyStr] = convertToJSONSerializable(val)
			}
		}
		return result
	case []interface{}:
		// Convert slice elements recursively
		result := make([]interface{}, len(v))
		for i, val := range v {
			result[i] = convertToJSONSerializable(val)
		}
		return result
	default:
		return value
	}
}

// isBinaryFile detects if a file is binary using a hybrid approach:
// 1. First, use MIME type detection for known binary formats (images, audio, video, etc.)
// 2. For unknown types (application/octet-stream), fall back to null-byte detection
//
// This approach is robust because:
// - It handles any file type, including custom/unusual extensions
// - It's the same heuristic used by git and other tools
// - It doesn't require maintaining a list of known extensions
func isBinaryFile(path string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()

	// Read enough for both MIME detection (512 bytes) and null-byte check (8KB like git)
	buf := make([]byte, 8192)
	n, err := file.Read(buf)
	if err != nil && err.Error() != "EOF" {
		return false, err
	}
	if n == 0 {
		return false, nil // Empty files are treated as text
	}

	// First: check MIME type using Go's built-in sniffer
	mimeType := http.DetectContentType(buf[:n])
	mimeType = strings.Split(mimeType, ";")[0] // Remove charset suffix
	mimeType = strings.TrimSpace(mimeType)

	// Known text types - definitely not binary
	if strings.HasPrefix(mimeType, "text/") {
		return false, nil
	}

	// Known binary types - skip these files
	if strings.HasPrefix(mimeType, "image/") ||
		strings.HasPrefix(mimeType, "audio/") ||
		strings.HasPrefix(mimeType, "video/") ||
		strings.HasPrefix(mimeType, "font/") ||
		mimeType == "application/pdf" ||
		mimeType == "application/zip" ||
		mimeType == "application/gzip" ||
		mimeType == "application/x-gzip" ||
		mimeType == "application/x-tar" ||
		mimeType == "application/x-rar-compressed" ||
		mimeType == "application/x-7z-compressed" ||
		mimeType == "application/x-executable" ||
		mimeType == "application/x-mach-binary" ||
		mimeType == "application/x-sharedlib" ||
		mimeType == "application/vnd.ms-excel" ||
		mimeType == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
		mimeType == "application/msword" ||
		mimeType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
		return true, nil
	}

	// For application/octet-stream (unknown) or other types,
	// fall back to null-byte detection - binary files contain null bytes, text files don't
	for i := 0; i < n; i++ {
		if buf[i] == 0 {
			return true, nil
		}
	}

	return false, nil
}

// OutputDependencyRegex matches {{ ._blocks.blockId.outputs.outputName }} patterns
// with optional whitespace and pipe functions.
//
// IMPORTANT: Keep in sync with the TypeScript implementation in:
//   web/src/components/mdx/TemplateInline/lib/extractOutputDependencies.ts
//
// Both implementations are validated against testdata/test-fixtures/output-dependencies/patterns.json
// to ensure they produce identical results. Run tests in both languages after any changes.
var OutputDependencyRegex = regexp.MustCompile(`\{\{\s*\._blocks\.([a-zA-Z0-9_-]+)\.outputs\.(\w+)(?:\s*\|[^}]*)?\s*\}\}`)

// ExtractOutputDependenciesFromContent extracts output dependencies from string content.
// This is the core extraction logic used by extractOutputDependenciesFromTemplateDir.
// It finds all {{ ._blocks.blockId.outputs.outputName }} patterns in the content.
func ExtractOutputDependenciesFromContent(content string) []OutputDependency {
	var dependencies []OutputDependency
	seen := make(map[string]bool)

	matches := OutputDependencyRegex.FindAllStringSubmatch(content, -1)
	for _, match := range matches {
		if len(match) >= 3 {
			originalBlockID := match[1]
			normalizedBlockID := normalizeBlockID(originalBlockID)
			outputName := match[2]
			// FullPath uses normalized ID for consistent lookups in Go templates
			fullPath := fmt.Sprintf("_blocks.%s.outputs.%s", normalizedBlockID, outputName)

			// Deduplicate
			if !seen[fullPath] {
				seen[fullPath] = true
				dependencies = append(dependencies, OutputDependency{
					BlockID:    originalBlockID, // Preserve original for display/reference
					OutputName: outputName,
					FullPath:   fullPath,
				})
			}
		}
	}

	return dependencies
}

// extractOutputDependenciesFromTemplateDir scans all template files in a directory
// for {{ ._blocks.blockId.outputs.outputName }} patterns and returns unique dependencies.
// This allows Template blocks to show warnings when dependent Check/Command blocks
// haven't been executed yet.
func extractOutputDependenciesFromTemplateDir(templateDir string) ([]OutputDependency, error) {
	var dependencies []OutputDependency
	seen := make(map[string]bool)

	// Walk the template directory
	err := filepath.Walk(templateDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip directories
		if info.IsDir() {
			return nil
		}

		// Skip binary files using content-based detection
		isBinary, err := isBinaryFile(path)
		if err != nil {
			slog.Warn("Failed to check if file is binary", "path", path, "error", err)
			return nil // Continue scanning other files
		}
		if isBinary {
			return nil
		}

		// Read file content
		content, err := os.ReadFile(path)
		if err != nil {
			slog.Warn("Failed to read template file for output dependency extraction", "path", path, "error", err)
			return nil // Continue scanning other files
		}

		// Extract dependencies from this file's content
		fileDeps := ExtractOutputDependenciesFromContent(string(content))
		for _, dep := range fileDeps {
			// Deduplicate across all files
			if !seen[dep.FullPath] {
				seen[dep.FullPath] = true
				dependencies = append(dependencies, dep)
			}
		}

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("failed to scan template directory for output dependencies: %w", err)
	}

	return dependencies, nil
}
