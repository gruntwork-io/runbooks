package api

import (
	"encoding/json"
	"fmt"
)

// Core data types
// ---

// File represents a file with its content and metadata
type File struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Content  string `json:"content"`
	Language string `json:"language"`
	Size     int64  `json:"size"`
}

// FileTreeNode represents a file or folder in the generated file tree
type FileTreeNode struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Type     string         `json:"type"` // "file" or "folder"
	Children []FileTreeNode `json:"children,omitempty"`
	File     *File          `json:"file,omitempty"` // Only present for files
}

// API request/response types
// ---

// RenderRequest represents the request body for rendering boilerplate templates
type RenderRequest struct {
	TemplatePath string         `json:"templatePath"`
	Variables    map[string]any `json:"variables"`
	// TemplateID uniquely identifies the Template component making this request.
	// Used for manifest tracking to enable smart file cleanup when template outputs change
	// (e.g., switching from Python to Node.js runtime deletes orphaned Python files).
	// If not provided, no manifest tracking or cleanup is performed.
	TemplateID   string         `json:"templateId,omitempty"`
	// Optional subdirectory within the configured output path (set via --output-path CLI flag).
	// SECURITY: Must be a relative path without ".." to prevent directory traversal attacks.
	// Will be joined with the CLI-configured output path (e.g., if CLI sets --output-path=/out
	// and this is "prod", files will be written to /out/prod).
	// Defaults to the CLI-configured output path if not provided.
	OutputPath   *string        `json:"outputPath,omitempty"`
}

// RenderResponse represents the response from the render endpoint
type RenderResponse struct {
	Message      string         `json:"message"`
	OutputDir    string         `json:"outputDir"`
	TemplatePath string         `json:"templatePath"`
	FileTree     []FileTreeNode `json:"fileTree"`
	// Cleanup statistics (only populated when TemplateID is provided in request)
	DeletedFiles  []string `json:"deletedFiles,omitempty"`  // Files that were deleted (orphaned from previous render)
	CreatedFiles  []string `json:"createdFiles,omitempty"`  // Files that were newly created
	ModifiedFiles []string `json:"modifiedFiles,omitempty"` // Files that were updated (content changed)
	SkippedFiles  []string `json:"skippedFiles,omitempty"`  // Files that were unchanged (no write needed)
}

// FlexibleBool is a boolean type that can be unmarshaled from both JSON boolean and string values.
// This handles cases where MDX authors write generateFile="true" instead of generateFile={true}.
type FlexibleBool bool

// UnmarshalJSON implements json.Unmarshaler for FlexibleBool
func (fb *FlexibleBool) UnmarshalJSON(data []byte) error {
	// Try to unmarshal as bool first
	var b bool
	if err := json.Unmarshal(data, &b); err == nil {
		*fb = FlexibleBool(b)
		return nil
	}
	
	// Try to unmarshal as string
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		switch s {
		case "true", "True", "TRUE", "1":
			*fb = true
		case "false", "False", "FALSE", "0", "":
			*fb = false
		default:
			return fmt.Errorf("invalid boolean string: %s", s)
		}
		return nil
	}
	
	return fmt.Errorf("cannot unmarshal %s into FlexibleBool", string(data))
}

// RenderInlineRequest represents a request to render template files provided in the request body
type RenderInlineRequest struct {
	// Map of relative file paths to their contents
	// Example: {"boilerplate.yml": "...", "main.tf": "..."}
	TemplateFiles map[string]string `json:"templateFiles"`
	Variables     map[string]any    `json:"variables"`
	// GenerateFile indicates whether to write files to the persistent output directory.
	// When false (default), files are only rendered and returned in the response.
	// When true, files are also written to the output directory (CLI-configured path + OutputPath).
	// Accepts both boolean and string values (e.g., true, "true", "false").
	GenerateFile  FlexibleBool      `json:"generateFile,omitempty"`
	// OutputPath is an optional subdirectory within the CLI-configured output path.
	// Only used when GenerateFile is true.
	// SECURITY: Must be a relative path without ".." to prevent directory traversal attacks.
	OutputPath    *string           `json:"outputPath,omitempty"`
}

// RenderInlineResponse represents the response from the inline render endpoint
type RenderInlineResponse struct {
	Message       string                           `json:"message"`
	RenderedFiles map[string]File                  `json:"renderedFiles"` // Map of file paths to file metadata
	FileTree      []FileTreeNode                   `json:"fileTree"`
}

// Boilerplate configuration types
// ---

// BoilerplateVariable represents a variable definition from boilerplate.yml
// Note that we define a simplified version of the BoilerplateVariable struct here.
// The official Variable struct in the boilerplate package is more complex and includes additional fields we don't need.
type BoilerplateVariable struct {
	Name                string            `json:"name"`
	Description         string            `json:"description"`
	Type                string            `json:"type"`
	Default             interface{}       `json:"default"`
	Required            bool              `json:"required"`
	Options             []string          `json:"options,omitempty"`
	Validations         []ValidationRule  `json:"validations,omitempty"`
	// Schema is a field not known to boilerplate itself, but we use it to allow users to define a schema for structured maps.
	// For example, a user could specify a schema for an AWS account map with the fields "email", "environment", and "id".
	// The frontend will then use this schema to render a form for the user to enter the data.
	// It will send the data to boilerplate as a map of strings, where the key is the entry name and the value is a map of strings, 
	// where the key is the field name and the value is the field value.
	// YAML property: x-schema (Runbooks extension, ignored by Boilerplate)
	Schema              map[string]string `json:"schema,omitempty"`              // For structured maps: field name -> type mapping

	// SchemaInstanceLabel is a field not known to boilerplate itself, but we use it to allow users to name an instance of a schema.
	// For example, a user could specify a schema instance label for an AWS account map with the value "Account Name".
	// The frontend will then use this label to render a form for the user to enter the data.
	// It will send the data to boilerplate as a map of strings, where the key is the entry name and the value is a map of strings, 
	// where the key is the field name and the value is the field value.
	// YAML property: x-schema-instance-label (Runbooks extension, ignored by Boilerplate)
	SchemaInstanceLabel string            `json:"schemaInstanceLabel,omitempty"` // Custom label for schema instances (e.g., "Account Name")

	// SectionName indicates which section this variable belongs to.
	// Used to look up a variable's section without searching the top-level Sections list.
	// See also: BoilerplateConfig.Sections for the ordered list of all section groupings.
	// YAML property: x-section (Runbooks extension, ignored by Boilerplate)
	SectionName string `json:"sectionName,omitempty"`
}

// BoilerplateValidationType represents the supported validation types from boilerplate
// The list of supported validations is current as of Sep 2025.
// https://github.com/gruntwork-io/boilerplate?tab=readme-ov-file#validations
type BoilerplateValidationType string

const (
	ValidationRequired     BoilerplateValidationType = "required"
	ValidationURL          BoilerplateValidationType = "url"
	ValidationEmail        BoilerplateValidationType = "email"
	ValidationAlpha        BoilerplateValidationType = "alpha"
	ValidationDigit        BoilerplateValidationType = "digit"
	ValidationAlphanumeric BoilerplateValidationType = "alphanumeric"
	ValidationCountryCode2 BoilerplateValidationType = "countrycode2"
	ValidationSemver       BoilerplateValidationType = "semver"
	ValidationLength       BoilerplateValidationType = "length"
	ValidationCustom       BoilerplateValidationType = "custom"
)

// ValidationRule represents a validation rule from a boilerplate.yml.
type ValidationRule struct {
	Type    BoilerplateValidationType `json:"type"`
	Message string                    `json:"message"`
	Args    []interface{}             `json:"args,omitempty"`
}

// Section represents a grouping of variables under a section header (Runbooks extension).
// This is used for UI rendering (e.g., rendering groups of variables in sections in the form).
// See also: BoilerplateVariable.SectionName for per-variable section lookup.
// YAML property: x-section (Runbooks extension, ignored by Boilerplate)
type Section struct {
	Name      string   `json:"name"`      // Section name ("" for unnamed/default section)
	Variables []string `json:"variables"` // Variable names in this section (in declaration order)
}

// BoilerplateConfig represents the parsed boilerplate.yml, which is a collection of variables
type BoilerplateConfig struct {
	Variables []BoilerplateVariable `json:"variables"`
	RawYaml   string                `json:"rawYaml"` // The original YAML content
	// Sections is an ordered list of section groupings for UI rendering.
	// Each Section contains a name and the list of variable names in that section.
	// Note: Individual variables also have a SectionName field for direct lookup.
	Sections []Section `json:"sections,omitempty"`
}

// BoilerplateRequest represents the request body for boilerplate variable parsing
type BoilerplateRequest struct {
	TemplatePath      string `json:"templatePath,omitempty"`      // Path to the boilerplate template directory
	BoilerplateContent string `json:"boilerplateContent,omitempty"` // Direct content of the boilerplate.yml file
}

// Generated files management types
// ---

// GeneratedFilesCheckResponse represents the response from the generated files check endpoint
type GeneratedFilesCheckResponse struct {
	HasFiles           bool   `json:"hasFiles"`           // Whether files exist in the output directory
	AbsoluteOutputPath string `json:"absoluteOutputPath"` // Absolute output path that was checked
	RelativeOutputPath string `json:"relativeOutputPath"` // The CLI-configured output path (as provided to --output-path)
	FileCount          int    `json:"fileCount"`          // Number of files found (0 if directory doesn't exist)
}

// GeneratedFilesDeleteResponse represents the response from the generated files delete endpoint
type GeneratedFilesDeleteResponse struct {
	Success      bool   `json:"success"`      // Whether the deletion was successful
	DeletedCount int    `json:"deletedCount"` // Number of files/folders deleted
	Message      string `json:"message"`      // Human-readable message about the operation
}
