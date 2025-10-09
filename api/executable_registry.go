package api

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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
	ID              string         `json:"id"`
	Type            ExecutableType `json:"type"`
	ComponentID     string         `json:"component_id"`
	ComponentType   string         `json:"component_type"` // "check" or "command"
	ScriptContent   string         `json:"-"`              // Not sent to frontend for security
	ScriptPath      string         `json:"script_path,omitempty"`
	BoilerplatePath string         `json:"boilerplate_path,omitempty"`
	TemplateVarNames []string       `json:"template_var_names,omitempty"` // Variable names used in template
	Language        string         `json:"language,omitempty"`
}

// ExecutableRegistry manages registered executables for a runbook
type ExecutableRegistry struct {
	runbookPath string
	executables map[string]*Executable
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
			ID:              exec.ID,
			Type:            exec.Type,
			ComponentID:     exec.ComponentID,
			ComponentType:   exec.ComponentType,
			ScriptPath:      exec.ScriptPath,
			BoilerplatePath: exec.BoilerplatePath,
			TemplateVarNames: exec.TemplateVarNames,
			Language:        exec.Language,
		}
	}
	return result
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

// parseComponents extracts and registers all components of a given type
func (r *ExecutableRegistry) parseComponents(content, runbookDir, componentType string) error {
	// Regex to match <Check> or <Command> components (handles both self-closing and with children)
	// Captures everything between opening and closing tags or self-closing tag
	pattern := fmt.Sprintf(`<%s\s+([^>]*?)(?:/>|>([\s\S]*?)</%s>)`, componentType, componentType)
	re := regexp.MustCompile(pattern)

	matches := re.FindAllStringSubmatch(content, -1)
	for _, match := range matches {
		props := match[1] // Component props

		// Extract component properties
		componentID := extractProp(props, "id")
		if componentID == "" {
			// Generate ID from position if not provided
			componentID = generateID(componentType, props)
		}

		// Extract path or command prop
		pathProp := extractProp(props, "path")
		commandProp := extractProp(props, "command")

		// Determine executable type and register
		if commandProp != "" {
			// Inline command
			if err := r.registerInlineExecutable(componentID, componentType, commandProp); err != nil {
				return err
			}
		} else if pathProp != "" {
			// File-based command
			if err := r.registerFileExecutable(componentID, componentType, pathProp, runbookDir); err != nil {
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
		ID:              generateExecutableID(componentID, scriptContent),
		Type:            ExecutableTypeInline,
		ComponentID:     componentID,
		ComponentType:   strings.ToLower(componentType),
		ScriptContent:   scriptContent,
		TemplateVarNames: extractTemplateVars(scriptContent),
	}

	r.mu.Lock()
	r.executables[exec.ID] = exec
	r.mu.Unlock()

	return nil
}

// registerFileExecutable registers a file-based script
func (r *ExecutableRegistry) registerFileExecutable(componentID, componentType, scriptPath, runbookDir string) error {
	// Resolve script path relative to runbook
	fullPath := filepath.Join(runbookDir, scriptPath)

	// Check if file exists
	if _, err := os.Stat(fullPath); err != nil {
		return fmt.Errorf("script file not found: %s", scriptPath)
	}

	// Read script content
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return fmt.Errorf("failed to read script file %s: %w", scriptPath, err)
	}

	scriptContent := string(content)

	exec := &Executable{
		ID:              generateExecutableID(componentID, scriptContent),
		Type:            ExecutableTypeFile,
		ComponentID:     componentID,
		ComponentType:   strings.ToLower(componentType),
		ScriptContent:   scriptContent,
		ScriptPath:      scriptPath,
		TemplateVarNames: extractTemplateVars(scriptContent),
	}

	r.mu.Lock()
	r.executables[exec.ID] = exec
	r.mu.Unlock()

	return nil
}

// extractProp extracts a prop value from component props string
func extractProp(props, propName string) string {
	// Handle both formats: prop="value" and prop={value}
	patterns := []string{
		fmt.Sprintf(`%s="([^"]*)"`, propName),
		fmt.Sprintf(`%s='([^']*)'`, propName),
		fmt.Sprintf(`%s=\{`+"`([^`]*)`"+`\}`, propName), // prop={`value`}
		fmt.Sprintf(`%s=\{"([^"]*)"\}`, propName),       // prop={"value"}
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

// generateExecutableID generates a unique ID for an executable
func generateExecutableID(componentID, content string) string {
	// Create hash of component ID + content for uniqueness
	hash := sha256.Sum256([]byte(componentID + content))
	return hex.EncodeToString(hash[:])[:16] // Use first 16 chars of hash
}

// generateID generates a component ID from its properties if not provided
func generateID(componentType, props string) string {
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

