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

	// Convert to our JSON structure
	result := &BoilerplateConfig{
		Variables: make([]BoilerplateVariable, 0, len(boilerplateConfig.Variables)),
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

		result.Variables = append(result.Variables, boilerplateVar)
	}

	return result, nil
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
