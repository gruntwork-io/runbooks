package testing

import (
	"crypto/sha256"
	"encoding/hex"
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

// GenerateTemplateInlineID generates an ID for a TemplateInline block based on its outputPath.
// If outputPath is provided, generates "template-{basename}-{hash}" where hash is an 8-character
// SHA256 hash of the full outputPath to disambiguate same filenames in different directories.
// If outputPath is empty, returns empty string (caller should handle fallback).
func GenerateTemplateInlineID(outputPath string) string {
	if outputPath == "" {
		return ""
	}
	baseName := filepath.Base(outputPath)
	if idx := strings.LastIndex(baseName, "."); idx > 0 {
		baseName = baseName[:idx]
	}
	// Add a short hash of the full outputPath to disambiguate same filenames in different dirs
	hash := sha256.Sum256([]byte(outputPath))
	shortHash := hex.EncodeToString(hash[:])[:8]
	return fmt.Sprintf("template-%s-%s", baseName, shortHash)
}

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

// InputValidator parses component blocks from a runbook, validates their
// configurations can be loaded, and validates test inputs against the schemas.
type InputValidator struct {
	runbookPath  string
	schemas      map[string]*InputsBlockSchema // inputsID -> schema
	configErrors ConfigErrors                  // errors encountered during validation
	components   []api.ParsedComponent         // all components in document order
}

// validateComponent performs structural validation on a parsed component.
// This mirrors frontend validation in web/src/components/mdx/*/
// Note: File existence checks are done separately since they require a runbook directory.
func validateComponent(comp api.ParsedComponent) []ConfigError {
	var errors []ConfigError

	switch comp.Type {
	case "Inputs":
		if !comp.HasExplicitID {
			errors = append(errors, ConfigError{
				ComponentType: "Inputs",
				ComponentID:   "(missing)",
				Message:       "the 'id' prop is required",
			})
		}
		configPath := api.ExtractProp(comp.Props, "path")
		configInline := comp.Content
		if configPath == "" && strings.TrimSpace(configInline) == "" {
			errors = append(errors, ConfigError{
				ComponentType: "Inputs",
				ComponentID:   comp.ID,
				Message:       "either 'path' prop or inline YAML content is required",
			})
		}

	case "Template":
		if !comp.HasExplicitID {
			errors = append(errors, ConfigError{
				ComponentType: "Template",
				ComponentID:   "(missing)",
				Message:       "the 'id' prop is required",
			})
		}
		if api.ExtractProp(comp.Props, "path") == "" {
			errors = append(errors, ConfigError{
				ComponentType: "Template",
				ComponentID:   comp.ID,
				Message:       "the 'path' prop is required",
			})
		}

	case "TemplateInline":
		if api.ExtractProp(comp.Props, "outputPath") == "" {
			errors = append(errors, ConfigError{
				ComponentType: "TemplateInline",
				ComponentID:   comp.ID,
				Message:       "the 'outputPath' prop is required",
			})
		}
		if strings.TrimSpace(comp.Content) == "" {
			errors = append(errors, ConfigError{
				ComponentType: "TemplateInline",
				ComponentID:   comp.ID,
				Message:       "template content is empty",
			})
		}

	case "Check", "Command":
		if !comp.HasExplicitID {
			errors = append(errors, ConfigError{
				ComponentType: comp.Type,
				ComponentID:   comp.ID, // Use auto-generated ID so lookups work
				Message:       "the 'id' prop is required",
			})
		}
		// Other validation (path/command props, file existence) handled by ExecutableRegistry
	}

	return errors
}

// NewInputValidator creates a validator for inputs in a runbook.
func NewInputValidator(runbookPath string) (*InputValidator, error) {
	v := &InputValidator{
		runbookPath:  runbookPath,
		schemas:      make(map[string]*InputsBlockSchema),
		configErrors: make(ConfigErrors, 0),
		components:   make([]api.ParsedComponent, 0),
	}

	if err := v.parseAndValidateComponents(); err != nil {
		return nil, fmt.Errorf("failed to parse runbook components: %w", err)
	}

	return v, nil
}

// KnownBlockTypes is the set of block types recognized by runbooks test.
// Any block not in this set will be reported as an error.
var KnownBlockTypes = map[string]bool{
	"Check":          true,
	"Command":        true,
	"Inputs":         true,
	"Template":       true,
	"TemplateInline": true,
	"AwsAuth":        true,
	"GitHubAuth":     true,
	"GitClone":       true,
	"Admonition":     true, // Decorative block - validated but not executed
}

// parseAndValidateComponents discovers and parses all component blocks in the runbook.
func (v *InputValidator) parseAndValidateComponents() error {
	content, err := os.ReadFile(v.runbookPath)
	if err != nil {
		return err
	}

	runbookDir := filepath.Dir(v.runbookPath)
	contentStr := string(content)

	// First, detect any unknown block types
	v.detectUnknownBlocks(contentStr)

	// Collect all components
	var allComponents []api.ParsedComponent

	// Parse and validate Inputs blocks
	allComponents = append(allComponents, v.parseAndValidateInputsBlocks(contentStr, runbookDir)...)

	// Parse and validate Check blocks (file existence checked by ExecutableRegistry)
	allComponents = append(allComponents, v.parseAndValidateExecutableBlocks(contentStr, "Check")...)

	// Parse and validate Command blocks (file existence checked by ExecutableRegistry)
	allComponents = append(allComponents, v.parseAndValidateExecutableBlocks(contentStr, "Command")...)

	// Parse and validate Template blocks
	allComponents = append(allComponents, v.parseAndValidateTemplateBlocks(contentStr, runbookDir)...)

	// Parse and validate TemplateInline blocks
	allComponents = append(allComponents, v.parseAndValidateTemplateInlineBlocks(contentStr)...)

	// Parse and validate AwsAuth blocks
	allComponents = append(allComponents, v.parseAndValidateAuthBlocks(contentStr, "AwsAuth")...)

	// Parse and validate GitHubAuth blocks
	allComponents = append(allComponents, v.parseAndValidateAuthBlocks(contentStr, "GitHubAuth")...)

	// Parse and validate GitClone blocks (same id-required validation as auth blocks)
	allComponents = append(allComponents, v.parseAndValidateAuthBlocks(contentStr, "GitClone")...)

	// Sort by document position
	sortComponentsByPosition(allComponents)

	v.components = allComponents
	return nil
}

// detectUnknownBlocks scans the content for block-like tags and reports
// any that are not in the KnownBlockTypes set.
func (v *InputValidator) detectUnknownBlocks(contentStr string) {
	// Find fenced code block ranges to skip (same as ParseComponents does)
	codeBlockRanges := api.FindFencedCodeBlockRanges(contentStr)

	// Regex to find PascalCase block tags: <BlockName followed by whitespace or />
	// This matches the MDX convention (PascalCase = custom block, lowercase = HTML)
	blockRe := regexp.MustCompile(`<([A-Z][a-zA-Z0-9]*)(?:\s|/>|>)`)
	matches := blockRe.FindAllStringSubmatchIndex(contentStr, -1)

	seen := make(map[string]bool)
	for _, match := range matches {
		// Skip if inside a fenced code block
		if api.IsInsideFencedCodeBlock(match[0], codeBlockRanges) {
			continue
		}

		blockType := contentStr[match[2]:match[3]]

		// Skip if already seen or known
		if seen[blockType] || KnownBlockTypes[blockType] {
			continue
		}
		seen[blockType] = true

		// Report unknown block type
		v.configErrors = append(v.configErrors, ConfigError{
			ComponentType: blockType,
			ComponentID:   "(unknown)",
			Message:       fmt.Sprintf("unknown block type %q is not supported by runbooks test", blockType),
		})
	}
}

// parseAndValidateAuthBlocks parses and validates AwsAuth or GitHubAuth blocks.
func (v *InputValidator) parseAndValidateAuthBlocks(contentStr, componentType string) []api.ParsedComponent {
	components := api.ParseComponents(contentStr, componentType)
	var results []api.ParsedComponent

	for _, comp := range components {
		// Validate: id is required
		if !comp.HasExplicitID {
			v.configErrors = append(v.configErrors, ConfigError{
				ComponentType: componentType,
				ComponentID:   "(missing)",
				Message:       "the 'id' prop is required",
			})
			comp.ID = "(missing)"
		}

		results = append(results, comp)
	}

	return results
}

// parseAndValidateExecutableBlocks parses and validates Check or Command blocks.
// File existence validation is handled by ExecutableRegistry; this validates structural requirements.
func (v *InputValidator) parseAndValidateExecutableBlocks(contentStr, componentType string) []api.ParsedComponent {
	components := api.ParseComponents(contentStr, componentType)

	for _, comp := range components {
		validationErrors := validateComponent(comp)
		v.configErrors = append(v.configErrors, validationErrors...)
	}

	return components
}

// sortComponentsByPosition sorts components by their position in the document
func sortComponentsByPosition(components []api.ParsedComponent) {
	for i := 0; i < len(components); i++ {
		for j := i + 1; j < len(components); j++ {
			if components[j].Position < components[i].Position {
				components[i], components[j] = components[j], components[i]
			}
		}
	}
}

// parseAndValidateInputsBlocks parses and validates all Inputs blocks.
// Returns parsed components and records any validation errors in configErrors.
func (v *InputValidator) parseAndValidateInputsBlocks(contentStr, runbookDir string) []api.ParsedComponent {
	components := api.ParseComponents(contentStr, "Inputs")
	var results []api.ParsedComponent

	for _, comp := range components {
		// Run structural validation
		validationErrors := validateComponent(comp)
		if len(validationErrors) > 0 {
			v.configErrors = append(v.configErrors, validationErrors...)
			// Update comp.ID for missing ID case
			if !comp.HasExplicitID {
				comp.ID = "(missing)"
			}
			results = append(results, comp)
			continue
		}

		// Skip duplicates (shouldn't happen, but be defensive)
		if _, exists := v.schemas[comp.ID]; exists {
			continue
		}

		// Load schema from config
		schema := &InputsBlockSchema{
			ID:        comp.ID,
			Variables: make(map[string]BoilerplateVariable),
		}

		configPath := api.ExtractProp(comp.Props, "path")
		if configPath != "" {
			_, fullPath := api.ResolveBoilerplatePath(runbookDir, configPath)
			cfg, err := loadBoilerplateConfig(fullPath)
			if err != nil {
				v.configErrors = append(v.configErrors, ConfigError{
					ComponentType: "Inputs",
					ComponentID:   comp.ID,
					Message:       fmt.Sprintf("failed to load boilerplate config: %v", err),
				})
			} else {
				for _, variable := range cfg.Variables {
					schema.Variables[variable.Name] = variable
				}
			}
		} else {
			configInline := strings.TrimSpace(comp.Content)
			cfg, err := parseInlineYAML(configInline)
			if err != nil {
				v.configErrors = append(v.configErrors, ConfigError{
					ComponentType: "Inputs",
					ComponentID:   comp.ID,
					Message:       fmt.Sprintf("failed to parse inline YAML: %v", err),
				})
			} else if cfg != nil {
				for _, variable := range cfg.Variables {
					schema.Variables[variable.Name] = variable
				}
			}
		}

		v.schemas[comp.ID] = schema
		results = append(results, comp)
	}

	return results
}

// parseAndValidateTemplateBlocks parses and validates Template blocks.
// Returns parsed components and records any validation errors in configErrors.
func (v *InputValidator) parseAndValidateTemplateBlocks(contentStr, runbookDir string) []api.ParsedComponent {
	components := api.ParseComponents(contentStr, "Template")
	var results []api.ParsedComponent

	for _, comp := range components {
		// Run structural validation
		validationErrors := validateComponent(comp)
		if len(validationErrors) > 0 {
			v.configErrors = append(v.configErrors, validationErrors...)
			if !comp.HasExplicitID {
				comp.ID = "(missing)"
			}
			results = append(results, comp)
			continue
		}

		// File-based validation: template directory and boilerplate.yml exist
		path := api.ExtractProp(comp.Props, "path")
		templateDir, boilerplatePath := api.ResolveBoilerplatePath(runbookDir, path)
		if _, err := os.Stat(templateDir); err != nil {
			v.configErrors = append(v.configErrors, ConfigError{
				ComponentType: "Template",
				ComponentID:   comp.ID,
				Message:       fmt.Sprintf("template directory not found: %s", path),
			})
			results = append(results, comp)
			continue
		}
		config, err := loadBoilerplateConfig(boilerplatePath)
		if err != nil {
			v.configErrors = append(v.configErrors, ConfigError{
				ComponentType: "Template",
				ComponentID:   comp.ID,
				Message:       fmt.Sprintf("failed to load boilerplate config: %v", err),
			})
		} else {
			// Load schema for input validation
			schema := &InputsBlockSchema{
				ID:        comp.ID,
				Variables: make(map[string]BoilerplateVariable),
			}
			for _, variable := range config.Variables {
				schema.Variables[variable.Name] = variable
			}
			v.schemas[comp.ID] = schema
		}

		results = append(results, comp)
	}

	return results
}

// parseAndValidateTemplateInlineBlocks parses and validates TemplateInline blocks.
// Returns parsed components and records any validation errors in configErrors.
func (v *InputValidator) parseAndValidateTemplateInlineBlocks(contentStr string) []api.ParsedComponent {
	components := api.ParseComponents(contentStr, "TemplateInline")
	var results []api.ParsedComponent

	// TemplateInline uses custom ID generation based on outputPath
	templateCount := 0
	seen := make(map[string]bool)

	for _, comp := range components {
		outputPath := api.ExtractProp(comp.Props, "outputPath")

		// Generate ID from outputPath
		if id := GenerateTemplateInlineID(outputPath); id != "" {
			comp.ID = id
		} else {
			templateCount++
			comp.ID = fmt.Sprintf("template-inline-%d", templateCount)
		}

		// Skip duplicates (using our custom ID, not ParseComponents' auto-generated one)
		if seen[comp.ID] {
			continue
		}
		seen[comp.ID] = true

		// Run structural validation (after setting custom ID)
		validationErrors := validateComponent(comp)
		v.configErrors = append(v.configErrors, validationErrors...)

		results = append(results, comp)
	}

	return results
}

// findComponentPosition finds the position of a component in the document
func findComponentPosition(content, componentType, id string) int {
	// Try to find the component with the specific ID
	if id != "" && id != "(missing)" {
		pattern := fmt.Sprintf(`<%s[^>]*id=["']%s["']`, componentType, regexp.QuoteMeta(id))
		re := regexp.MustCompile(pattern)
		if loc := re.FindStringIndex(content); loc != nil {
			return loc[0]
		}
	}

	// Fallback: find any component of this type
	pattern := fmt.Sprintf(`<%s\s+`, componentType)
	re := regexp.MustCompile(pattern)
	if loc := re.FindStringIndex(content); loc != nil {
		return loc[0]
	}

	return 0
}

// ValidateInputValues validates resolved test values against the discovered boilerplate schemas.
// This checks that the values provided in the test YAML are valid according to the schema
// (correct types, valid enum values, required fields, etc.).
func (v *InputValidator) ValidateInputValues(inputs map[string]interface{}) ValidationErrors {
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
// This includes Inputs, Check, Command, Template, and TemplateInline blocks.
// GetComponents returns all parsed components in document order.
func (v *InputValidator) GetComponents() []api.ParsedComponent {
	return v.components
}

// GetConfigError returns the config error for a specific component, if any.
func (v *InputValidator) GetConfigError(componentType, componentID string) string {
	for _, err := range v.configErrors {
		if err.ComponentType == componentType && err.ComponentID == componentID {
			return err.Message
		}
	}
	return ""
}

// GetConfigErrorByID returns the config error for a component with the given ID.
// This searches all component types and returns the first matching error.
func (v *InputValidator) GetConfigErrorByID(componentID string) string {
	for _, err := range v.configErrors {
		if err.ComponentID == componentID {
			return err.Message
		}
	}
	return ""
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
func parseInlineYAML(content string) (*BoilerplateConfig, error) {
	// Extract YAML from code fence if present
	yamlContent := content
	codeFenceRe := regexp.MustCompile("(?s)```(?:yaml|yml)?\\s*\\n(.+?)```")
	if match := codeFenceRe.FindStringSubmatch(content); len(match) > 1 {
		yamlContent = match[1]
	}

	var config BoilerplateConfig
	if err := yaml.Unmarshal([]byte(yamlContent), &config); err != nil {
		return nil, err
	}

	return &config, nil
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
