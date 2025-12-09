package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	bpConfig "github.com/gruntwork-io/boilerplate/config"
	bpVariables "github.com/gruntwork-io/boilerplate/variables"
	"gopkg.in/yaml.v3"
)

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

		if req.TemplatePath != "" {
			// Extract the directory from the runbookPath (which we assume is a file path)
			runbookDir := filepath.Dir(runbookPath)

			// Construct the full path
			fullPath := filepath.Join(runbookDir, req.TemplatePath, "boilerplate.yml")
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

	// Include the raw YAML content in the response
	config.RawYaml = content

	slog.Info("Successfully parsed boilerplate config", "variableCount", len(config.Variables))
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

	// Parse raw YAML to extract custom fields (Runbooks extensions with x- prefix)
	schemas := extractSchemasFromYAML(boilerplateYamlContent)
	schemaInstanceLabels := extractSchemaInstanceLabelsFromYAML(boilerplateYamlContent)
	// Extract section groupings: an ordered list of sections, each with the associated variable names.
	sections := extractSectionGroupings(boilerplateYamlContent)
	// Extract variable-to-section mapping: a lookup table from variable name -> section name.
	variableToSection := extractVariablesToSectionMap(boilerplateYamlContent)

	// Convert to our JSON structure
	result := &BoilerplateConfig{
		Variables: make([]BoilerplateVariable, 0, len(boilerplateConfig.Variables)),
		Sections:  sections,
	}

	for _, variable := range boilerplateConfig.Variables {
		// Convert default value to JSON-serializable format
		defaultValue := convertToJSONSerializable(variable.Default())

		// Extract validations and determine if required
		validations := extractValidations(variable.Validations())
		isRequired := isVariableRequired(variable.Validations())

		slog.Debug("Variable validation info", "name", variable.Name(), "validationCount", len(variable.Validations()), "required", isRequired)

		// Use the variable type as-is (no fallback since we enforce strict schema adherence)
		variableType := string(variable.Type())

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

// extractSchemasFromYAML parses the raw YAML to extract schema definitions for variables
// Returns a map of variable name to schema (field name -> type)
// YAML property: x-schema (Runbooks extension, ignored by Boilerplate)
func extractSchemasFromYAML(yamlContent string) map[string]map[string]string {
	// Define a structure that matches the boilerplate.yml format
	type rawVariable struct {
		Name   string            `yaml:"name"`
		Schema map[string]string `yaml:"x-schema"`
	}
	type rawConfig struct {
		Variables []rawVariable `yaml:"variables"`
	}

	var config rawConfig
	if err := yaml.Unmarshal([]byte(yamlContent), &config); err != nil {
		slog.Warn("Failed to parse YAML for schema extraction", "error", err)
		return map[string]map[string]string{}
	}

	schemas := make(map[string]map[string]string)
	for _, variable := range config.Variables {
		if len(variable.Schema) > 0 {
			schemas[variable.Name] = variable.Schema
		}
	}

	return schemas
}

// extractSchemaInstanceLabelsFromYAML parses the raw YAML to extract x-schema-instance-label definitions for map variables
// Returns a map of variable name to schema instance label string
// YAML property: x-schema-instance-label (Runbooks extension, ignored by Boilerplate)
func extractSchemaInstanceLabelsFromYAML(yamlContent string) map[string]string {
	// Define a structure that matches the boilerplate.yml format
	type rawVariable struct {
		Name                string `yaml:"name"`
		SchemaInstanceLabel string `yaml:"x-schema-instance-label"`
	}
	type rawConfig struct {
		Variables []rawVariable `yaml:"variables"`
	}

	var config rawConfig
	if err := yaml.Unmarshal([]byte(yamlContent), &config); err != nil {
		slog.Warn("Failed to parse YAML for x-schema-instance-label extraction", "error", err)
		return map[string]string{}
	}

	schemaInstanceLabels := make(map[string]string)
	for _, variable := range config.Variables {
		if variable.SchemaInstanceLabel != "" {
			schemaInstanceLabels[variable.Name] = variable.SchemaInstanceLabel
		}
	}

	return schemaInstanceLabels
}

// extractVariablesToSectionMap parses the raw YAML to extract x-section for each variable.
// Returns a map of variable name -> section name (for attaching to individual variables).
// This is used to populate BoilerplateVariable.SectionName.
// YAML property: x-section (Runbooks extension, ignored by Boilerplate)
func extractVariablesToSectionMap(yamlContent string) map[string]string {
	// Define a structure that matches the boilerplate.yml format
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
		return map[string]string{}
	}

	variableToSection := make(map[string]string)
	for _, variable := range config.Variables {
		if variable.Section != "" {
			variableToSection[variable.Name] = variable.Section
		}
	}

	return variableToSection
}

// extractSectionGroupings parses the raw YAML to build an ordered list of section groupings.
// Returns an ordered slice of Section structs for UI rendering (e.g., rendering collapsible sections).
// Each Section contains the section name and the list of variable names in that section.
// Variables without a section use "" (empty string) as the section name.
// The unnamed section ("") is always placed first if it exists.
// YAML property: x-section (Runbooks extension, ignored by Boilerplate)
func extractSectionGroupings(yamlContent string) []Section {
	// Define a structure that matches the boilerplate.yml format
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

	// Use a map to collect variables per section, and track order of first occurrence
	sectionVars := make(map[string][]string)
	var sectionOrder []string
	seenSections := make(map[string]bool)

	for _, variable := range config.Variables {
		sectionName := variable.Section // Empty string if not specified

		// Add variable to its section
		sectionVars[sectionName] = append(sectionVars[sectionName], variable.Name)

		// Track section order (first occurrence)
		if !seenSections[sectionName] {
			seenSections[sectionName] = true
			sectionOrder = append(sectionOrder, sectionName)
		}
	}

	// Ensure "" (unnamed section) is always first if it exists
	if seenSections[""] && len(sectionOrder) > 0 && sectionOrder[0] != "" {
		// Find and move "" to the front
		newOrder := []string{""}
		for _, s := range sectionOrder {
			if s != "" {
				newOrder = append(newOrder, s)
			}
		}
		sectionOrder = newOrder
	}

	// Build the result slice
	sections := make([]Section, 0, len(sectionOrder))
	for _, name := range sectionOrder {
		sections = append(sections, Section{
			Name:      name,
			Variables: sectionVars[name],
		})
	}

	return sections
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
