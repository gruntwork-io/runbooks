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
	OutputPath   *string        `json:"outputPath,omitempty"` // Optional output path, defaults to "generated" if not provided
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
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Type        string           `json:"type"`
	Default     interface{}      `json:"default"`
	Required    bool             `json:"required"`
	Options     []string         `json:"options,omitempty"`
	Validations []ValidationRule `json:"validations,omitempty"`
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
