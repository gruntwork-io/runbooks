package testing

import (
	"fmt"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"runbooks/api"

	"gopkg.in/yaml.v3"
)

// ValidationError represents a single validation error.
type ValidationError struct {
	InputKey string // e.g., "project.Name"
	Message  string // e.g., "value 'dev2' not in enum options [dev, staging, prod]"
}

// ValidationErrors is a collection of validation errors.
type ValidationErrors []ValidationError

// Error implements the error interface.
func (e ValidationErrors) Error() string {
	if len(e) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("input validation failed:\n")
	for _, err := range e {
		sb.WriteString(fmt.Sprintf("  - %s: %s\n", err.InputKey, err.Message))
	}
	return sb.String()
}

// BoilerplateVariable represents a variable definition from a boilerplate config.
type BoilerplateVariable struct {
	Name        string      `yaml:"name"`
	Type        string      `yaml:"type"`
	Description string      `yaml:"description,omitempty"`
	Default     interface{} `yaml:"default,omitempty"`
	Options     []string    `yaml:"options,omitempty"` // For enum type
	Validations Validations `yaml:"validations,omitempty"`
}

// Validations can be a single string, a list of strings, or a list of maps.
type Validations []interface{}

// UnmarshalYAML handles both string and slice formats for validations.
func (v *Validations) UnmarshalYAML(value *yaml.Node) error {
	// Try as a single string first
	var strVal string
	if err := value.Decode(&strVal); err == nil {
		*v = Validations{strVal}
		return nil
	}

	// Try as a slice
	var sliceVal []interface{}
	if err := value.Decode(&sliceVal); err == nil {
		*v = Validations(sliceVal)
		return nil
	}

	// Default to empty
	*v = Validations{}
	return nil
}

// ParsedValidations holds parsed validation constraints.
type ParsedValidations struct {
	Required    bool
	MinLength   int
	MaxLength   int
	Min         int
	Max         int
	Pattern     string
	Email       bool
	URL         bool
}

// ParseValidations parses the validations field into structured constraints.
func (v *BoilerplateVariable) ParseValidations() ParsedValidations {
	result := ParsedValidations{}

	for _, val := range v.Validations {
		switch vv := val.(type) {
		case string:
			switch vv {
			case "required":
				result.Required = true
			case "email":
				result.Email = true
			case "url":
				result.URL = true
			}
		case map[string]interface{}:
			for key, value := range vv {
				switch key {
				case "minLength":
					if n, ok := toInt(value); ok {
						result.MinLength = n
					}
				case "maxLength":
					if n, ok := toInt(value); ok {
						result.MaxLength = n
					}
				case "min":
					if n, ok := toInt(value); ok {
						result.Min = n
					}
				case "max":
					if n, ok := toInt(value); ok {
						result.Max = n
					}
				case "pattern":
					if s, ok := value.(string); ok {
						result.Pattern = s
					}
				}
			}
		case map[interface{}]interface{}:
			// Handle YAML's default map type
			for key, value := range vv {
				keyStr, ok := key.(string)
				if !ok {
					continue
				}
				switch keyStr {
				case "minLength":
					if n, ok := toInt(value); ok {
						result.MinLength = n
					}
				case "maxLength":
					if n, ok := toInt(value); ok {
						result.MaxLength = n
					}
				case "min":
					if n, ok := toInt(value); ok {
						result.Min = n
					}
				case "max":
					if n, ok := toInt(value); ok {
						result.Max = n
					}
				case "pattern":
					if s, ok := value.(string); ok {
						result.Pattern = s
					}
				}
			}
		}
	}

	return result
}

// BoilerplateConfig represents a boilerplate.yml file structure.
type BoilerplateConfig struct {
	Variables []BoilerplateVariable `yaml:"variables"`
}

// InputsBlockSchema represents the schema for an Inputs block.
type InputsBlockSchema struct {
	ID        string
	Variables map[string]BoilerplateVariable // varName -> variable def
}

// ConfigError represents a configuration error in a component.
type ConfigError struct {
	ComponentType string // e.g., "Inputs", "Template"
	ComponentID   string // e.g., "project"
	Message       string // The error message
}

// ConfigErrors is a collection of configuration errors.
type ConfigErrors []ConfigError

// Error implements the error interface.
func (e ConfigErrors) Error() string {
	if len(e) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("component configuration errors:\n")
	for _, err := range e {
		fmt.Fprintf(&sb, "  - <%s id=%q>: %s\n", err.ComponentType, err.ComponentID, err.Message)
	}
	return sb.String()
}

// ComponentValidationResult holds the validation result for a single component.
// This is used for Inputs, Template, and other component types.
type ComponentValidationResult struct {
	ComponentType string // e.g., "Inputs", "Template"
	ComponentID   string // The component's id prop
	Error         string // Empty if valid, error message if invalid
}


// InputValidator parses Inputs blocks from a runbook, validates their
// configurations can be loaded, and validates test inputs against the schemas.
type InputValidator struct {
	runbookPath        string
	schemas            map[string]*InputsBlockSchema // inputsID -> schema
	configErrors       ConfigErrors                  // errors encountered while loading schemas
	inputsValidations  []ComponentValidationResult   // validation results for all Inputs blocks (in order)
}

// NewInputValidator creates a validator for inputs in a runbook.
func NewInputValidator(runbookPath string) (*InputValidator, error) {
	v := &InputValidator{
		runbookPath:       runbookPath,
		schemas:           make(map[string]*InputsBlockSchema),
		configErrors:      make(ConfigErrors, 0),
		inputsValidations: make([]ComponentValidationResult, 0),
	}

	if err := v.loadSchemas(); err != nil {
		return nil, fmt.Errorf("failed to load input schemas: %w", err)
	}

	return v, nil
}

// parsedInputsBlock represents a parsed Inputs block from the MDX.
// The boilerplate config comes from either configPath (external file) or
// configInline (YAML content between tags), but not both.
type parsedInputsBlock struct {
	id           string
	configPath   string // path prop: load config from external file
	configInline string // inner content: inline YAML between <Inputs>...</Inputs>
}

// validateInputsBlock checks a parsed Inputs block for configuration errors.
// Returns nil if valid, or a ConfigError describing the problem.
func validateInputsBlock(block parsedInputsBlock) *ConfigError {
	if block.id == "" {
		return &ConfigError{
			ComponentType: "Inputs",
			ComponentID:   "(missing)",
			Message:       "the 'id' prop is required",
		}
	}

	if block.configPath == "" && block.configInline == "" {
		return &ConfigError{
			ComponentType: "Inputs",
			ComponentID:   block.id,
			Message:       "either 'path' prop or inline YAML content is required",
		}
	}

	return nil
}

// parseInputsBlocks extracts all Inputs blocks from MDX content.
// Handles both container (<Inputs>...</Inputs>) and self-closing (<Inputs />) forms.
func parseInputsBlocks(content string) []parsedInputsBlock {
	var blocks []parsedInputsBlock
	seen := make(map[string]bool)

	// Pattern for container Inputs: <Inputs ...>...</Inputs>
	containerRe := regexp.MustCompile(`<Inputs\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*?)>([\s\S]*?)</Inputs>`)
	for _, match := range containerRe.FindAllStringSubmatch(content, -1) {
		props := match[1]
		id := extractPropValue(props, "id")
		// Include blocks even with empty IDs so we can report them as errors
		if !seen[id] {
			seen[id] = true
			blocks = append(blocks, parsedInputsBlock{
				id:           id,
				configPath:   extractPropValue(props, "path"),
				configInline: match[2],
			})
		}
	}

	// Pattern for self-closing Inputs: <Inputs ... />
	selfClosingRe := regexp.MustCompile(`<Inputs\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*?)\s*/>`)
	for _, match := range selfClosingRe.FindAllStringSubmatch(content, -1) {
		props := match[1]
		id := extractPropValue(props, "id")
		// Include blocks even with empty IDs so we can report them as errors
		if !seen[id] {
			seen[id] = true
			blocks = append(blocks, parsedInputsBlock{
				id:         id,
				configPath: extractPropValue(props, "path"),
				// configInline is empty for self-closing tags
			})
		}
	}

	return blocks
}

// loadSchemas discovers and parses all Inputs/Template blocks in the runbook.
func (v *InputValidator) loadSchemas() error {
	content, err := os.ReadFile(v.runbookPath)
	if err != nil {
		return err
	}

	runbookDir := filepath.Dir(v.runbookPath)
	contentStr := string(content)

	// Parse all Inputs blocks (both container and self-closing)
	inputsBlocks := parseInputsBlocks(contentStr)

	// Process each Inputs block
	for _, block := range inputsBlocks {
		validationResult := ComponentValidationResult{
			ComponentType: "Inputs",
			ComponentID:   block.id,
		}

		// Validate block structure
		if err := validateInputsBlock(block); err != nil {
			v.configErrors = append(v.configErrors, *err)
			validationResult.Error = err.Message
			// Use ID from error if block.id is empty
			if validationResult.ComponentID == "" {
				validationResult.ComponentID = err.ComponentID
			}
			v.inputsValidations = append(v.inputsValidations, validationResult)
			continue
		}

		// Skip duplicates (shouldn't happen, but be defensive)
		if _, exists := v.schemas[block.id]; exists {
			continue
		}

		schema := &InputsBlockSchema{
			ID:        block.id,
			Variables: make(map[string]BoilerplateVariable),
		}

		if block.configPath != "" {
			// Load from external file - use the same path resolution as the API
			// The API treats the path as a directory and appends "boilerplate.yml"
			_, fullPath := api.ResolveBoilerplatePath(runbookDir, block.configPath)
			cfg, err := loadBoilerplateConfig(fullPath)
			if err != nil {
				errMsg := fmt.Sprintf("failed to load boilerplate config: %v", err)
				v.configErrors = append(v.configErrors, ConfigError{
					ComponentType: "Inputs",
					ComponentID:   block.id,
					Message:       errMsg,
				})
				validationResult.Error = errMsg
			} else {
				for _, variable := range cfg.Variables {
					schema.Variables[variable.Name] = variable
				}
			}
		} else {
			// Parse inline YAML from container content
			if cfg := parseInlineYAML(block.configInline); cfg != nil {
				for _, variable := range cfg.Variables {
					schema.Variables[variable.Name] = variable
				}
			}
		}

		v.schemas[block.id] = schema
		v.inputsValidations = append(v.inputsValidations, validationResult)
	}

	// Parse Template blocks
	templateRe := regexp.MustCompile(`<Template\s+([^>]*(?:"[^"]*"|'[^']*'|` + "`[^`]*`" + `|[^>])*)(?:/>|>)`)
	for _, match := range templateRe.FindAllStringSubmatch(contentStr, -1) {
		props := match[1]
		id := extractPropValue(props, "id")
		templatePath := extractPropValue(props, "path")

		if id == "" || templatePath == "" {
			continue
		}

		boilerplatePath := filepath.Join(runbookDir, templatePath, "boilerplate.yml")
		config, err := loadBoilerplateConfig(boilerplatePath)
		if err != nil {
			continue // Skip if can't load - Template blocks will be validated separately
		}

		schema := &InputsBlockSchema{
			ID:        id,
			Variables: make(map[string]BoilerplateVariable),
		}

		for _, variable := range config.Variables {
			schema.Variables[variable.Name] = variable
		}

		v.schemas[id] = schema
	}

	return nil
}

// Validate validates resolved inputs against the discovered schemas.
func (v *InputValidator) Validate(inputs map[string]interface{}) ValidationErrors {
	var errors ValidationErrors

	for key, value := range inputs {
		// Parse "inputsID.varName" format
		parts := strings.SplitN(key, ".", 2)
		if len(parts) != 2 {
			continue
		}

		inputsID := parts[0]
		varName := parts[1]

		schema, ok := v.schemas[inputsID]
		if !ok {
			// Unknown inputs block - skip validation
			continue
		}

		variable, ok := schema.Variables[varName]
		if !ok {
			// Unknown variable - skip validation
			continue
		}

		// Validate the value
		if errs := validateValue(key, value, variable); len(errs) > 0 {
			errors = append(errors, errs...)
		}
	}

	return errors
}

// GetSchema returns the schema for an inputs block.
func (v *InputValidator) GetSchema(inputsID string) *InputsBlockSchema {
	return v.schemas[inputsID]
}

// GetAllSchemas returns all discovered schemas.
func (v *InputValidator) GetAllSchemas() map[string]*InputsBlockSchema {
	return v.schemas
}

// GetConfigErrors returns any configuration errors found while loading schemas.
func (v *InputValidator) GetConfigErrors() ConfigErrors {
	return v.configErrors
}

// HasConfigErrors returns true if there are any configuration errors.
func (v *InputValidator) HasConfigErrors() bool {
	return len(v.configErrors) > 0
}

// GetComponentValidations returns validation results for all components in document order.
// Currently this includes Inputs blocks; Template validation will be added in the future.
func (v *InputValidator) GetComponentValidations() []ComponentValidationResult {
	// For now, only Inputs blocks are validated
	// Future: append Template validations, etc.
	return v.inputsValidations
}

// validateValue validates a single value against its variable definition.
func validateValue(key string, value interface{}, variable BoilerplateVariable) []ValidationError {
	var errors []ValidationError
	constraints := variable.ParseValidations()

	// Type-specific validation
	switch variable.Type {
	case "enum":
		strVal := fmt.Sprintf("%v", value)
		if !contains(variable.Options, strVal) {
			errors = append(errors, ValidationError{
				InputKey: key,
				Message:  fmt.Sprintf("value %q not in enum options %v", strVal, variable.Options),
			})
		}

	case "string":
		strVal := fmt.Sprintf("%v", value)

		// Length constraints
		if constraints.MinLength > 0 && len(strVal) < constraints.MinLength {
			errors = append(errors, ValidationError{
				InputKey: key,
				Message:  fmt.Sprintf("length %d is less than minimum %d", len(strVal), constraints.MinLength),
			})
		}
		if constraints.MaxLength > 0 && len(strVal) > constraints.MaxLength {
			errors = append(errors, ValidationError{
				InputKey: key,
				Message:  fmt.Sprintf("length %d exceeds maximum %d", len(strVal), constraints.MaxLength),
			})
		}

		// Pattern validation
		if constraints.Pattern != "" {
			if matched, _ := regexp.MatchString(constraints.Pattern, strVal); !matched {
				errors = append(errors, ValidationError{
					InputKey: key,
					Message:  fmt.Sprintf("value %q does not match pattern %q", strVal, constraints.Pattern),
				})
			}
		}

		// Email validation
		if constraints.Email {
			if _, err := mail.ParseAddress(strVal); err != nil {
				errors = append(errors, ValidationError{
					InputKey: key,
					Message:  fmt.Sprintf("value %q is not a valid email address", strVal),
				})
			}
		}

		// URL validation
		if constraints.URL {
			if _, err := url.ParseRequestURI(strVal); err != nil {
				errors = append(errors, ValidationError{
					InputKey: key,
					Message:  fmt.Sprintf("value %q is not a valid URL", strVal),
				})
			}
		}

	case "int":
		var intVal int
		switch v := value.(type) {
		case int:
			intVal = v
		case int64:
			intVal = int(v)
		case float64:
			intVal = int(v)
		default:
			errors = append(errors, ValidationError{
				InputKey: key,
				Message:  fmt.Sprintf("expected integer, got %T", value),
			})
			return errors
		}

		if constraints.Min != 0 && intVal < constraints.Min {
			errors = append(errors, ValidationError{
				InputKey: key,
				Message:  fmt.Sprintf("value %d is less than minimum %d", intVal, constraints.Min),
			})
		}
		if constraints.Max != 0 && intVal > constraints.Max {
			errors = append(errors, ValidationError{
				InputKey: key,
				Message:  fmt.Sprintf("value %d exceeds maximum %d", intVal, constraints.Max),
			})
		}

	case "bool":
		if _, ok := value.(bool); !ok {
			errors = append(errors, ValidationError{
				InputKey: key,
				Message:  fmt.Sprintf("expected boolean, got %T", value),
			})
		}
	}

	// Required validation (applies to all types)
	if constraints.Required && isEmptyValue(value) {
		errors = append(errors, ValidationError{
			InputKey: key,
			Message:  "value is required but was empty",
		})
	}

	return errors
}

// loadBoilerplateConfig loads a boilerplate.yml file.
func loadBoilerplateConfig(path string) (*BoilerplateConfig, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var config BoilerplateConfig
	if err := yaml.Unmarshal(content, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

// parseInlineYAML parses YAML content from an inline Inputs block.
func parseInlineYAML(content string) *BoilerplateConfig {
	// Extract YAML from code fence if present
	yamlContent := content
	codeFenceRe := regexp.MustCompile("(?s)```(?:yaml|yml)?\\s*\\n(.+?)```")
	if match := codeFenceRe.FindStringSubmatch(content); len(match) > 1 {
		yamlContent = match[1]
	}

	var config BoilerplateConfig
	if err := yaml.Unmarshal([]byte(yamlContent), &config); err != nil {
		return nil
	}

	return &config
}

// extractPropValue extracts a prop value from a props string.
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

// Helper functions

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

func isEmptyValue(value interface{}) bool {
	if value == nil {
		return true
	}
	switch v := value.(type) {
	case string:
		return v == ""
	case []interface{}:
		return len(v) == 0
	case map[string]interface{}:
		return len(v) == 0
	}
	return false
}

func toInt(value interface{}) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		return int(v), true
	}
	return 0, false
}
