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
	bpOptions "github.com/gruntwork-io/boilerplate/options"
	bpTemplates "github.com/gruntwork-io/boilerplate/templates"
	bpVariables "github.com/gruntwork-io/boilerplate/variables"
)

// validateOutputPath validates an output path from an API request to prevent security issues.
// It ensures the path is:
// - Not absolute (to prevent writing to arbitrary filesystem locations)
// - Does not contain ".." (to prevent directory traversal attacks)
// Returns an error if validation fails.
func validateOutputPath(path string) error {
	// Empty path is allowed (will use default)
	if path == "" {
		return nil
	}
	
	// Check for absolute paths (Unix-style and Windows-style)
	if filepath.IsAbs(path) {
		return fmt.Errorf("absolute paths are not allowed in API requests: %s", path)
	}
	
	// Additional check for Windows paths on Unix systems
	if len(path) >= 2 && path[1] == ':' {
		return fmt.Errorf("absolute paths are not allowed in API requests: %s", path)
	}
	
	// Check for directory traversal attempts
	if containsDirectoryTraversal(path) {
		return fmt.Errorf("directory traversal is not allowed: %s", path)
	}
	
	return nil
}

// containsDirectoryTraversal checks if a path contains ".." components
func containsDirectoryTraversal(path string) bool {
	// Normalize path separators
	normalizedPath := filepath.ToSlash(path)
	
	// Check for ".." as a path component
	// This handles: "..", "../foo", "foo/../bar", "foo/.."
	parts := strings.Split(normalizedPath, "/")
	for _, part := range parts {
		if part == ".." {
			return true
		}
	}
	
	return false
}

// determineOutputDirectory determines the final output directory based on CLI config and API request.
// CLI output path is the path set via the --output-path CLI flag and is trusted (specified by end user)
// API request output path is the path specified in a component prop in the Runbook and is untrusted (specified by runbook author).
// If apiRequestOutputPath is provided, it's validated and treated as a subdirectory within the CLI path.
// Returns the absolute output directory path or an error.
func determineOutputDirectory(cliOutputPath string, apiRequestOutputPath *string) (string, error) {
	var outputDir string
	
	if apiRequestOutputPath != nil && *apiRequestOutputPath != "" {
		// Validate the API-provided output path for security
		if err := validateOutputPath(*apiRequestOutputPath); err != nil {
			return "", fmt.Errorf("invalid output path: %w", err)
		}
		
		// Treat the validated path as a subdirectory within the CLI output path
		if filepath.IsAbs(cliOutputPath) {
			outputDir = filepath.Join(cliOutputPath, *apiRequestOutputPath)
		} else {
			currentDir, err := os.Getwd()
			if err != nil {
				return "", fmt.Errorf("failed to get current working directory: %w", err)
			}
			outputDir = filepath.Join(currentDir, cliOutputPath, *apiRequestOutputPath)
		}
	} else {
		// Use the CLI output path
		if filepath.IsAbs(cliOutputPath) {
			outputDir = cliOutputPath
		} else {
			currentDir, err := os.Getwd()
			if err != nil {
				return "", fmt.Errorf("failed to get current working directory: %w", err)
			}
			outputDir = filepath.Join(currentDir, cliOutputPath)
		}
	}
	
	return outputDir, nil
}

// This handler renders a boilerplate template with the provided variables.

// HandleBoilerplateRender renders a boilerplate template with the provided variables
func HandleBoilerplateRender(runbookPath string, cliOutputPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req RenderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			slog.Error("Failed to parse render request", "error", err)
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid request body",
				"details": err.Error(),
			})
			return
		}

		if req.TemplatePath == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "templatePath is required",
			})
			return
		}

		// Extract the directory from the baseRunbookPath (which we assume is a file path)
		runbookDir := filepath.Dir(runbookPath)

		// Construct the full template path
		fullTemplatePath := filepath.Join(runbookDir, req.TemplatePath)
		slog.Info("Rendering boilerplate template", "baseDir", runbookDir, "req.TemplatePath", req.TemplatePath, "fullTemplatePath", fullTemplatePath)

		// Check if the template directory exists
		if _, err := os.Stat(fullTemplatePath); os.IsNotExist(err) {
			slog.Error("Template directory not found", "path", fullTemplatePath)
			c.JSON(http.StatusNotFound, gin.H{
				"error":   "Template directory not found",
				"details": "Tried to access: " + fullTemplatePath,
			})
			return
		}

		// Determine the output directory
		outputDir, err := determineOutputDirectory(cliOutputPath, req.OutputPath)
		if err != nil {
			slog.Error("Failed to determine output directory", "error", err)
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid output path",
				"details": err.Error(),
			})
			return
		}

		// Create the output directory if it doesn't exist
		if err := os.MkdirAll(outputDir, 0755); err != nil {
			slog.Error("Failed to create output directory", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to create output directory",
				"details": err.Error(),
			})
			return
		}

		slog.Info("Rendering template to output directory", "outputDir", outputDir)

		// Render the template using the boilerplate package
		err = renderBoilerplateTemplate(fullTemplatePath, outputDir, req.Variables)
		if err != nil {
			slog.Error("Failed to render boilerplate template", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to render template",
				"details": err.Error(),
			})
			return
		}

		slog.Info("Successfully rendered boilerplate template to output directory")

		// Build file tree from the generated output
		fileTree, err := buildFileTreeWithRoot(outputDir, "")
		if err != nil {
			slog.Error("Failed to build file tree", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to build file tree",
				"details": err.Error(),
			})
			return
		}

		// Create response with file tree
		response := RenderResponse{
			Message:      "Template rendered successfully to output directory",
			OutputDir:    outputDir,
			TemplatePath: fullTemplatePath,
			FileTree:     fileTree,
		}

		c.JSON(http.StatusOK, response)
	}
}

// renderBoilerplateTemplate renders a boilerplate template using direct function calls
func renderBoilerplateTemplate(templatePath, outputDir string, variables map[string]any) error {
	slog.Info("renderBoilerplateTemplate called", "templatePath", templatePath, "outputDir", outputDir)

	// Create boilerplate options for direct function calls
	opts := &bpOptions.BoilerplateOptions{
		TemplateURL:             templatePath,
		TemplateFolder:          templatePath, // For local templates, use the same path
		OutputFolder:            outputDir,
		Vars:                    variables,
		NonInteractive:          true, // Don't prompt for input
		OnMissingKey:            bpOptions.ExitWithError,
		OnMissingConfig:         bpOptions.Exit,
		NoHooks:                 true, // Disable hooks for now
		NoShell:                 true, // Disable shell commands for now
		DisableDependencyPrompt: true,
		ExecuteAllShellCommands: false,
		ShellCommandAnswers:     make(map[string]bool),
	}

	slog.Info("Boilerplate options created", "TemplateFolder", opts.TemplateFolder)

	// Load the boilerplate configuration to get variable definitions
	boilerplateConfig, err := bpConfig.LoadBoilerplateConfig(opts)
	if err != nil {
		return fmt.Errorf("failed to load boilerplate config: %w", err)
	}

	// Convert variables to the correct types based on the boilerplate config
	convertedVariables, err := convertVariablesToCorrectTypes(variables, boilerplateConfig.GetVariablesMap())
	if err != nil {
		return fmt.Errorf("failed to convert variables to correct types: %w", err)
	}

	// Update the options with converted variables
	opts.Vars = convertedVariables

	// Create an empty dependency for the root template
	emptyDep := bpVariables.Dependency{}

	slog.Info("Processing boilerplate template directly", "templatePath", templatePath, "outputDir", outputDir)

	// Process the template using the boilerplate library directly
	err = bpTemplates.ProcessTemplate(opts, opts, emptyDep)
	if err != nil {
		return fmt.Errorf("failed to process boilerplate template: %w", err)
	}

	return nil
}

// convertVariablesToCorrectTypes converts variables to the correct types based on boilerplate config
func convertVariablesToCorrectTypes(variables map[string]any, variablesInConfig map[string]bpVariables.Variable) (map[string]any, error) {
	converted := make(map[string]any)

	for name, value := range variables {
		// Check if this variable is defined in the boilerplate config
		if variable, exists := variablesInConfig[name]; exists {
			// Pre-convert JSON number types to Go types before calling ConvertType
			preConvertedValue := preConvertJSONTypes(value, variable.Type())

			// Convert the value to the correct type
			convertedValue, err := bpVariables.ConvertType(preConvertedValue, variable)
			if err != nil {
				return nil, fmt.Errorf("failed to convert variable %s: %w", name, err)
			}
			converted[name] = convertedValue
		} else {
			// Variable not in config, use as-is
			converted[name] = value
		}
	}

	return converted, nil
}

// preConvertJSONTypes converts JSON number types to Go types before boilerplate conversion
func preConvertJSONTypes(value any, variableType bpVariables.BoilerplateType) any {
	switch variableType {
	case bpVariables.Int:
		// Convert float64 to int for JSON numbers
		if floatVal, ok := value.(float64); ok {
			return int(floatVal)
		}
	case bpVariables.Float:
		// float64 is already correct for JSON numbers
		return value
	case bpVariables.Bool:
		// bool is already correct for JSON
		return value
	case bpVariables.String:
		// string is already correct for JSON
		return value
	case bpVariables.List:
		// []interface{} is already correct for JSON arrays
		return value
	case bpVariables.Map:
		// map[string]interface{} is already correct for JSON objects
		return value
	case bpVariables.Enum:
		// string is already correct for JSON
		return value
	}

	return value
}

// HandleBoilerplateRenderInline renders boilerplate templates provided directly in the request body
func HandleBoilerplateRenderInline() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req RenderInlineRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			slog.Error("Failed to parse inline render request", "error", err)
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid request body",
				"details": err.Error(),
			})
			return
		}

		if len(req.TemplateFiles) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "templateFiles is required and must not be empty",
			})
			return
		}

		// Create a temporary directory for the template files
		tempDir, err := os.MkdirTemp("", "boilerplate-template-*")
		if err != nil {
			slog.Error("Failed to create temporary directory", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to create temporary directory",
				"details": err.Error(),
			})
			return
		}
		defer os.RemoveAll(tempDir) // Clean up temp directory when done
		slog.Info("Created temporary directory for template files", "tempDir", tempDir)

		// Write template files to the temporary directory
		for relPath, content := range req.TemplateFiles {
			fullPath := filepath.Join(tempDir, relPath)
			
			// Create parent directories if they don't exist
			if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
				slog.Error("Failed to create directory", "path", filepath.Dir(fullPath), "error", err)
				c.JSON(http.StatusInternalServerError, gin.H{
					"error":   "Failed to create directory structure",
					"details": err.Error(),
				})
				return
			}

			// Write the file
			if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
				slog.Error("Failed to write template file", "path", fullPath, "error", err)
				c.JSON(http.StatusInternalServerError, gin.H{
					"error":   "Failed to write template file",
					"details": err.Error(),
				})
				return
			}
			slog.Debug("Wrote template file", "path", fullPath)
		}

		// Create a temporary output directory
		outputDir, err := os.MkdirTemp("", "boilerplate-output-*")
		if err != nil {
			slog.Error("Failed to create output directory", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to create output directory",
				"details": err.Error(),
			})
			return
		}
		defer os.RemoveAll(outputDir) // Clean up output directory when done
		slog.Info("Created temporary output directory", "outputDir", outputDir)

		// Render the template using the boilerplate package
		err = renderBoilerplateTemplate(tempDir, outputDir, req.Variables)
		if err != nil {
			slog.Error("Failed to render boilerplate template", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to render template",
				"details": err.Error(),
			})
			return
		}

		slog.Info("Successfully rendered boilerplate template")

		// Read all rendered files from the output directory
		renderedFiles, err := readAllFilesInDirectory(outputDir)
		if err != nil {
			slog.Error("Failed to read rendered files", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to read rendered files",
				"details": err.Error(),
			})
			return
		}

		// Build file tree from the generated output
		fileTree, err := buildFileTreeWithRoot(outputDir, "")
		if err != nil {
			slog.Error("Failed to build file tree", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to build file tree",
				"details": err.Error(),
			})
			return
		}

		// Create response with rendered files and file tree
		response := RenderInlineResponse{
			Message:       "Template rendered successfully",
			RenderedFiles: renderedFiles,
			FileTree:      fileTree,
		}

		c.JSON(http.StatusOK, response)
	}
}

// renderBoilerplateContent renders boilerplate template content with variables and returns the rendered string
func renderBoilerplateContent(content string, variables map[string]string) (string, error) {
	// Create a temporary directory for the template
	tempDir, err := os.MkdirTemp("", "inline-template-*")
	if err != nil {
		return "", fmt.Errorf("failed to create temp directory: %w", err)
	}
	defer os.RemoveAll(tempDir)

	// Create a minimal boilerplate.yml config file
	boilerplateConfig := "variables: []"
	configPath := filepath.Join(tempDir, "boilerplate.yml")
	if err := os.WriteFile(configPath, []byte(boilerplateConfig), 0644); err != nil {
		return "", fmt.Errorf("failed to write boilerplate config: %w", err)
	}

	// Write template content to a temp file
	templateFile := "template.txt"
	templatePath := filepath.Join(tempDir, templateFile)
	if err := os.WriteFile(templatePath, []byte(content), 0644); err != nil {
		return "", fmt.Errorf("failed to write template file: %w", err)
	}

	// Create a temporary output directory
	outputDir, err := os.MkdirTemp("", "inline-output-*")
	if err != nil {
		return "", fmt.Errorf("failed to create output directory: %w", err)
	}
	defer os.RemoveAll(outputDir)

	// Convert map[string]string to map[string]any for boilerplate
	vars := make(map[string]any)
	for k, v := range variables {
		vars[k] = v
	}

	// Render using boilerplate
	if err := renderBoilerplateTemplate(tempDir, outputDir, vars); err != nil {
		return "", fmt.Errorf("failed to render boilerplate template: %w", err)
	}

	// Read the rendered output file
	renderedPath := filepath.Join(outputDir, templateFile)
	rendered, err := os.ReadFile(renderedPath)
	if err != nil {
		return "", fmt.Errorf("failed to read rendered output: %w", err)
	}

	return string(rendered), nil
}

// readAllFilesInDirectory recursively reads all files in a directory and returns a map of relative paths to file metadata
func readAllFilesInDirectory(rootDir string) (map[string]File, error) {
	files := make(map[string]File)
	
	err := filepath.Walk(rootDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		
		// Skip directories
		if info.IsDir() {
			return nil
		}
		
		// Read the file
		content, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("failed to read file %s: %w", path, err)
		}
		
		// Get the relative path from the root directory
		relPath, err := filepath.Rel(rootDir, path)
		if err != nil {
			return fmt.Errorf("failed to get relative path for %s: %w", path, err)
		}
		
		// Create file metadata with language detection
		fileName := filepath.Base(path)
		fileMetadata := File{
			Name:     fileName,
			Path:     relPath,
			Content:  string(content),
			Language: getLanguageFromExtension(fileName),
			Size:     info.Size(),
		}
		
		files[relPath] = fileMetadata
		return nil
	})
	
	if err != nil {
		return nil, err
	}
	
	return files, nil
}
