package api

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
}

// RenderInlineRequest represents a request to render template files provided in the request body
type RenderInlineRequest struct {
	// Map of relative file paths to their contents
	// Example: {"boilerplate.yml": "...", "main.tf": "..."}
	TemplateFiles map[string]string `json:"templateFiles"`
	Variables     map[string]any    `json:"variables"`
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
	Schema              map[string]string `json:"schema,omitempty"`              // For structured maps: field name -> type mapping

	// SchemaInstanceLable is a field not known to boilerplate itself, but we use it to allow users to name an instance of a schema.
	// For example, a user could specify a schema instance label for an AWS account map with the value "Account Name".
	// The frontend will then use this label to render a form for the user to enter the data.
	// It will send the data to boilerplate as a map of strings, where the key is the entry name and the value is a map of strings, 
	// where the key is the field name and the value is the field value.
	SchemaInstanceLabel string            `json:"schemaInstanceLabel,omitempty"` // Custom label for schema instances (e.g., "Account Name")
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

// BoilerplateConfig represents the parsed boilerplate.yml, which is a collection of variables
type BoilerplateConfig struct {
	Variables   []BoilerplateVariable `json:"variables"`
	RawYaml     string                `json:"rawYaml"`     // The original YAML content
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
	HasFiles   bool   `json:"hasFiles"`   // Whether files exist in the output directory
	OutputPath string `json:"outputPath"` // The output path that was checked
	FileCount  int    `json:"fileCount"`  // Number of files found (0 if directory doesn't exist)
}

// GeneratedFilesDeleteResponse represents the response from the generated files delete endpoint
type GeneratedFilesDeleteResponse struct {
	Success      bool   `json:"success"`      // Whether the deletion was successful
	DeletedCount int    `json:"deletedCount"` // Number of files/folders deleted
	Message      string `json:"message"`      // Human-readable message about the operation
}
