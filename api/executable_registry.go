package api

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// The idea here is we don't want to expose an API that executes arbitrary commands.
// Instead, we scan a runbook to see what scripts (or "executables") it contains, and
// then only allow the API to accept requests to execute those executables, albeit with variable values.
//
// This ExecutableRegistry is a "registry" of all the executables in a runbook.

// ExecutableType represents the source of the executable script
type ExecutableType string

const (
	ExecutableTypeInline ExecutableType = "inline" // Script defined in MDX via command prop
	ExecutableTypeFile   ExecutableType = "file"   // Script loaded from file via path prop
)

// Executable represents a registered script that can be executed
type Executable struct {
	ID                string         `json:"id"`
	Type              ExecutableType `json:"type"`
	ComponentID       string         `json:"component_id"`
	ComponentType     string         `json:"component_type"` // "check" or "command"
	ScriptContent     string         `json:"-"`                          // Not sent to frontend for security
	ScriptContentHash string         `json:"script_content_hash"`        // Hash of script content for drift detection
	ScriptPath        string         `json:"script_path,omitempty"`
	BoilerplatePath   string         `json:"boilerplate_path,omitempty"`
	TemplateVarNames  []string       `json:"template_var_names,omitempty"` // Variable names used in template
	Language          string         `json:"language,omitempty"`
}

// ExecutableRegistry manages registered executables for a runbook
type ExecutableRegistry struct {
	runbookPath string
	executables map[string]*Executable
	warnings    []string     // Warnings collected during parsing (e.g., duplicate components)
	mu          sync.RWMutex // Protects executables map from concurrent access by HTTP handlers
}

// NewExecutableRegistry creates a new executable registry
func NewExecutableRegistry(runbookPath string) (*ExecutableRegistry, error) {
	registry := &ExecutableRegistry{
		runbookPath: runbookPath,
		executables: make(map[string]*Executable),
	}

	// Parse the runbook and register all executables
	if err := registry.parseAndRegister(); err != nil {
		return nil, fmt.Errorf("failed to parse runbook: %w", err)
	}

	return registry, nil
}

// GetExecutable retrieves an executable by ID
func (r *ExecutableRegistry) GetExecutable(id string) (*Executable, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	exec, ok := r.executables[id]
	return exec, ok
}

// GetAllExecutables returns a map of all executables (without script content)
func (r *ExecutableRegistry) GetAllExecutables() map[string]*Executable {
	r.mu.RLock()
	defer r.mu.RUnlock()

	// Create a copy without script content for security
	result := make(map[string]*Executable)
	for id, exec := range r.executables {
		result[id] = &Executable{
			ID:                exec.ID,
			Type:              exec.Type,
			ComponentID:       exec.ComponentID,
			ComponentType:     exec.ComponentType,
			ScriptContentHash: exec.ScriptContentHash,
			ScriptPath:        exec.ScriptPath,
			BoilerplatePath:   exec.BoilerplatePath,
			TemplateVarNames:  exec.TemplateVarNames,
			Language:          exec.Language,
		}
	}
	return result
}

// GetWarnings returns all warnings collected during parsing
func (r *ExecutableRegistry) GetWarnings() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.warnings
}

// parseAndRegister parses the runbook file and registers all executables
func (r *ExecutableRegistry) parseAndRegister() error {
	// Read runbook file
	content, err := os.ReadFile(r.runbookPath)
	if err != nil {
		return fmt.Errorf("failed to read runbook: %w", err)
	}

	runbookContent := string(content)
	runbookDir := filepath.Dir(r.runbookPath)

	// Parse Check components
	if err := r.parseComponents(runbookContent, runbookDir, "Check"); err != nil {
		return fmt.Errorf("failed to parse Check components: %w", err)
	}

	// Parse Command components
	if err := r.parseComponents(runbookContent, runbookDir, "Command"); err != nil {
		return fmt.Errorf("failed to parse Command components: %w", err)
	}

	return nil
}

// GetComponentRegex returns a compiled regex for matching MDX components.
// Matches both self-closing and container components: <Type .../> or <Type ...>...</Type>
// The props pattern handles characters inside quoted attribute values:
// - Double quoted strings: "..."
// - Single quoted strings: '...'
// - JSX expressions with template literals: {`...`}
// - JSX expressions with double quotes: {"..."}
// - JSX expressions with single quotes: {'...'}
func GetComponentRegex(componentType string) *regexp.Regexp {
	// Pattern to match attribute values that may contain > characters
	// This handles: attr="value with >" or attr='value with >' or attr={`template with >`} etc.
	propsPattern := `(?:"[^"]*"|'[^']*'|\{` + "`[^`]*`" + `\}|\{"[^"]*"\}|\{'[^']*'\}|[^>])*?`
	pattern := fmt.Sprintf(`<%s\s+(%s)(?:/>|>([\s\S]*?)</%s>)`, componentType, propsPattern, componentType)
	return regexp.MustCompile(pattern)
}

// ParsedComponent represents a parsed MDX component with its properties.
type ParsedComponent struct {
	ID            string // Component ID (explicit or auto-generated)
	Type          string // e.g., "Check", "Command"
	Props         string // Raw props string; use ExtractProp to get specific values
	Content       string // Content between tags (for container components)
	Position      int    // Position in document (byte offset)
	HasExplicitID bool   // True if ID was provided in props, false if auto-generated
}

// ParseComponents finds all components of a given type in the content and returns their parsed info.
// This is the shared parsing logic used by both ExecutableRegistry and InputValidator.
// Components inside fenced code blocks (```...```) are skipped as they are documentation examples.
func ParseComponents(content, componentType string) []ParsedComponent {
	re := GetComponentRegex(componentType)
	matches := re.FindAllStringSubmatchIndex(content, -1)

	// Find all fenced code block ranges to skip components inside them
	codeBlockRanges := FindFencedCodeBlockRanges(content)

	var components []ParsedComponent
	seen := make(map[string]bool)

	for _, match := range matches {
		// FindAllStringSubmatchIndex returns pairs of indices:
		// match[0:2] = full match, match[2:4] = props (group 1), match[4:6] = content (group 2, optional)
		// We need at least 4 indices to have the props capture group
		if len(match) < 4 {
			continue
		}

		// Skip components inside fenced code blocks (documentation examples)
		if IsInsideFencedCodeBlock(match[0], codeBlockRanges) {
			continue
		}

		props := content[match[2]:match[3]]
		explicitID := ExtractProp(props, "id")
		id := explicitID
		if id == "" {
			id = ComputeComponentID(componentType, props)
		}

		// Skip duplicates
		if seen[id] {
			continue
		}
		seen[id] = true

		// Extract content between tags (if present, for container components)
		var componentContent string
		if len(match) >= 6 && match[4] >= 0 && match[5] >= 0 {
			componentContent = content[match[4]:match[5]]
		}

		components = append(components, ParsedComponent{
			ID:            id,
			Type:          componentType,
			Props:         props,
			Content:       componentContent,
			Position:      match[0],
			HasExplicitID: explicitID != "",
		})
	}

	return components
}

// parseComponents extracts and registers all components of a given type
func (r *ExecutableRegistry) parseComponents(content, runbookDir, componentType string) error {
	components := ParseComponents(content, componentType)

	for _, comp := range components {
		command := ExtractProp(comp.Props, "command")
		path := ExtractProp(comp.Props, "path")

		if command != "" {
			// Inline command
			if err := r.registerInlineExecutable(comp.ID, componentType, command); err != nil {
				return err
			}
		} else if path != "" {
			// File-based command
			if err := r.registerFileExecutable(comp.ID, componentType, path, runbookDir); err != nil {
				return err
			}
		}
	}

	return nil
}

// registerInlineExecutable registers an inline script
func (r *ExecutableRegistry) registerInlineExecutable(componentID, componentType, scriptContent string) error {
	// Unescape the command content (MDX props are often escaped)
	scriptContent = unescapeString(scriptContent)

	exec := &Executable{
		ID:                computeExecutableID(componentID, scriptContent),
		Type:              ExecutableTypeInline,
		ComponentID:       componentID,
		ComponentType:     strings.ToLower(componentType),
		ScriptContent:     scriptContent,
		ScriptContentHash: computeContentHash(scriptContent),
		TemplateVarNames:  extractTemplateVars(scriptContent),
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Check for duplicate component
	if existing, exists := r.executables[exec.ID]; exists {
		warning := getDuplicateWarningMessage(componentType, componentID)
		r.warnings = append(r.warnings, warning)
		slog.Warn("Duplicate component detected",
			"component_type", componentType,
			"component_id", componentID,
			"executable_id", exec.ID,
			"first_component_id", existing.ComponentID)
		return nil // Skip adding duplicate
	}

	r.executables[exec.ID] = exec
	return nil
}

// registerFileExecutable registers a file-based script
func (r *ExecutableRegistry) registerFileExecutable(componentID, componentType, scriptPath, runbookDir string) error {
	// Resolve script path relative to runbook
	fullPath := filepath.Join(runbookDir, scriptPath)

	// Check if file exists - if not, add warning and skip (don't fail startup)
	if _, err := os.Stat(fullPath); err != nil {
		warning := fmt.Sprintf("<%s id=\"%s\">: Script file not found: %s", componentType, componentID, scriptPath)
		r.mu.Lock()
		r.warnings = append(r.warnings, warning)
		r.mu.Unlock()
		slog.Warn("Script file not found, skipping registration",
			"component_type", componentType,
			"component_id", componentID,
			"script_path", scriptPath)
		return nil // Continue without failing (so we can handle in UI)
	}

	// Read script content
	content, err := os.ReadFile(fullPath)
	if err != nil {
		warning := fmt.Sprintf("<%s id=\"%s\">: Failed to read script file %s: %v", componentType, componentID, scriptPath, err)
		r.mu.Lock()
		r.warnings = append(r.warnings, warning)
		r.mu.Unlock()
		slog.Warn("Failed to read script file, skipping registration",
			"component_type", componentType,
			"component_id", componentID,
			"script_path", scriptPath,
			"error", err)
		return nil // Continue without failing (so we can handle in UI)
	}

	scriptContent := string(content)

	exec := &Executable{
		ID:                computeExecutableID(componentID, scriptContent),
		Type:              ExecutableTypeFile,
		ComponentID:       componentID,
		ComponentType:     strings.ToLower(componentType),
		ScriptContent:     scriptContent,
		ScriptContentHash: computeContentHash(scriptContent),
		ScriptPath:        scriptPath,
		TemplateVarNames:  extractTemplateVars(scriptContent),
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Check for duplicate component
	if existing, exists := r.executables[exec.ID]; exists {
		warning := getDuplicateWarningMessage(componentType, componentID)
		r.warnings = append(r.warnings, warning)
		slog.Warn("Duplicate component detected",
			"component_type", componentType,
			"component_id", componentID,
			"executable_id", exec.ID,
			"first_component_id", existing.ComponentID)
		return nil // Skip adding duplicate
	}

	r.executables[exec.ID] = exec
	return nil
}

// getDuplicateWarningMessage creates a standardized warning message for duplicate components
func getDuplicateWarningMessage(componentType, componentID string) string {
	return fmt.Sprintf(
		"Duplicate <%s> component with id '%s' detected - Any scripts or commands associated with the second instance will be ignored. Add a unique id to each component to distinguish them.",
		componentType, componentID,
	)
}

// extractProp extracts a prop value from component props string
// ExtractProp extracts a prop value from MDX component props string.
// Handles formats: prop="value", prop='value', prop={`value`}, prop={"value"}, prop={'value'}
func ExtractProp(props, propName string) string {
	// Handle both formats: prop="value" and prop={value}
	patterns := []string{
		fmt.Sprintf(`%s="([^"]*)"`, propName),
		fmt.Sprintf(`%s='([^']*)'`, propName),
		fmt.Sprintf(`%s=\{`+"`([^`]*)`"+`\}`, propName), // prop={`value`}
		fmt.Sprintf(`%s=\{"([^"]*)"\}`, propName),       // prop={"value"}
		fmt.Sprintf(`%s=\{'([^']*)'\}`, propName),       // prop={'value'}
	}

	for _, pattern := range patterns {
		re := regexp.MustCompile(pattern)
		if match := re.FindStringSubmatch(props); len(match) > 1 {
			return match[1]
		}
	}

	return ""
}

// extractTemplateVars extracts variable names from boilerplate template syntax
func extractTemplateVars(content string) []string {
	// Match {{.VarName}} or {{ .VarName }} pattern (with optional spaces)
	re := regexp.MustCompile(`\{\{\s*\.(\w+)\s*\}\}`)
	matches := re.FindAllStringSubmatch(content, -1)

	// Use map to deduplicate
	varMap := make(map[string]bool)
	for _, match := range matches {
		if len(match) > 1 {
			varMap[match[1]] = true
		}
	}

	// Convert to slice
	vars := make([]string, 0, len(varMap))
	for varName := range varMap {
		vars = append(vars, varName)
	}

	return vars
}

// computeExecutableID computes a deterministic ID for an executable
func computeExecutableID(componentID, content string) string {
	// Create hash of component ID + content for uniqueness
	hash := sha256.Sum256([]byte(componentID + content))
	return hex.EncodeToString(hash[:])[:16] // Use first 16 chars of hash
}

// computeContentHash computes a SHA256 hash of the script content
// This is used to detect when script files have changed on disk after server startup
func computeContentHash(content string) string {
	hash := sha256.Sum256([]byte(content))
	return hex.EncodeToString(hash[:])
}

// computeComponentID computes a deterministic component ID from its properties
// ComputeComponentID generates a deterministic ID for a component without an explicit id prop.
// Uses a hash of the component type and props to ensure uniqueness.
func ComputeComponentID(componentType, props string) string {
	// Use hash of component type + props
	hash := sha256.Sum256([]byte(componentType + props))
	return componentType + "_" + hex.EncodeToString(hash[:])[:8]
}

// unescapeString unescapes common MDX/HTML entities
func unescapeString(s string) string {
	s = strings.ReplaceAll(s, "&quot;", "\"")
	s = strings.ReplaceAll(s, "&apos;", "'")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&amp;", "&")
	return s
}

// validateRunbook validates a runbook for duplicate components
// This is used in live-reload mode to provide warnings if duplicate components are detected
func validateRunbook(filePath string) ([]string, error) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read runbook: %w", err)
	}

	var warnings []string

	// Check all component types that use IDs
	componentTypes := []string{
		"Check",
		"Command",
		"BoilerplateInputs",
		"BoilerplateTemplate",
	}

	for _, componentType := range componentTypes {
		warnings = append(warnings, validateComponentType(string(content), componentType)...)
	}

	return warnings, nil
}

// validateComponentType checks for duplicate components of a specific type
// Components inside fenced code blocks (```...```) are skipped as they are documentation examples.
func validateComponentType(content, componentType string) []string {
	re := GetComponentRegex(componentType)
	matches := re.FindAllStringSubmatchIndex(content, -1)

	// Find all fenced code block ranges to skip components inside them
	codeBlockRanges := FindFencedCodeBlockRanges(content)

	seen := make(map[string]bool)
	var warnings []string

	for _, match := range matches {
		// Skip components inside fenced code blocks (documentation examples)
		if IsInsideFencedCodeBlock(match[0], codeBlockRanges) {
			continue
		}

		// FindAllStringSubmatchIndex returns pairs of indices:
		// match[0:2] = full match, match[2:4] = props (group 1)
		if len(match) < 4 {
			continue
		}

		props := content[match[2]:match[3]]
		id := ExtractProp(props, "id")
		if id == "" {
			id = ComputeComponentID(componentType, props)
		}

		if seen[id] {
			warning := getDuplicateWarningMessage(componentType, id)
			warnings = append(warnings, warning)
			slog.Warn("Duplicate component detected during validation",
				"component_type", componentType,
				"component_id", id)
		}
		seen[id] = true
	}

	return warnings
}

// getExecutableByComponentID parses the runbook on-demand and returns an Executable for the given component ID
// This is used in live-reload mode to bypass registry validation
func getExecutableByComponentID(runbookPath, componentID string) (*Executable, error) {
	content, err := os.ReadFile(runbookPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read runbook: %w", err)
	}

	runbookDir := filepath.Dir(runbookPath)

	// Try Check components
	executable, err := findComponentExecutable(string(content), runbookDir, "Check", componentID)
	if err == nil {
		return executable, nil
	}

	// Try Command components
	executable, err = findComponentExecutable(string(content), runbookDir, "Command", componentID)
	if err == nil {
		return executable, nil
	}

	return nil, fmt.Errorf("component not found: %s", componentID)
}

// findComponentExecutable searches for a component and returns it as an Executable
// Components inside fenced code blocks (```...```) are skipped as they are documentation examples.
func findComponentExecutable(content, runbookDir, componentType, targetID string) (*Executable, error) {
	re := GetComponentRegex(componentType)

	matches := re.FindAllStringSubmatchIndex(content, -1)

	// Find all fenced code block ranges to skip components inside them
	codeBlockRanges := FindFencedCodeBlockRanges(content)

	for _, match := range matches {
		// Skip components inside fenced code blocks (documentation examples)
		if IsInsideFencedCodeBlock(match[0], codeBlockRanges) {
			continue
		}

		// FindAllStringSubmatchIndex returns pairs of indices:
		// match[0:2] = full match, match[2:4] = props (group 1)
		if len(match) < 4 {
			continue
		}

		props := content[match[2]:match[3]]

		componentID := ExtractProp(props, "id")
		if componentID == "" {
			componentID = ComputeComponentID(componentType, props)
		}

		if componentID != targetID {
			continue
		}

		// Found! Extract and return executable
		pathProp := ExtractProp(props, "path")
		commandProp := ExtractProp(props, "command")

		if commandProp != "" {
			// Inline executable
			commandProp = unescapeString(commandProp)
			return &Executable{
				ID:              componentID,
				Type:            ExecutableTypeInline,
				ComponentID:     componentID,
				ComponentType:   strings.ToLower(componentType),
				ScriptContent:   commandProp,
				TemplateVarNames: extractTemplateVars(commandProp),
			}, nil
		} else if pathProp != "" {
			// File executable
			fullPath := filepath.Join(runbookDir, pathProp)
			scriptContent, err := os.ReadFile(fullPath)
			if err != nil {
				return nil, fmt.Errorf("failed to read script file: %w", err)
			}

			return &Executable{
				ID:              componentID,
				Type:            ExecutableTypeFile,
				ComponentID:     componentID,
				ComponentType:   strings.ToLower(componentType),
				ScriptContent:   string(scriptContent),
				ScriptPath:      pathProp,
				TemplateVarNames: extractTemplateVars(string(scriptContent)),
			}, nil
		}
	}

	return nil, fmt.Errorf("component not found")
}

