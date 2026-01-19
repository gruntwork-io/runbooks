package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
	bpConfig "github.com/gruntwork-io/boilerplate/config"
	bpOptions "github.com/gruntwork-io/boilerplate/options"
	bpTemplates "github.com/gruntwork-io/boilerplate/templates"
	bpVariables "github.com/gruntwork-io/boilerplate/variables"
)

// determineOutputDirectory determines the final output directory based on CLI config and API request.
// CLI output path is the path set via the --output-path CLI flag and is trusted (specified by end user)
// API request output path is the path specified in a component prop in the Runbook and is untrusted (specified by runbook author).
// If apiRequestOutputPath is provided, it's validated and treated as a subdirectory within the CLI path.
// Returns the absolute output directory path or an error.
func determineOutputDirectory(cliOutputPath string, apiRequestOutputPath *string) (string, error) {
	var outputDir string
	
	if apiRequestOutputPath != nil && *apiRequestOutputPath != "" {
		// Validate the API-provided output path for security
		if err := ValidateRelativePath(*apiRequestOutputPath); err != nil {
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

// prepareOutputDirectory determines the output directory path and creates it if needed.
// This is shared logic used by both HandleBoilerplateRender and HandleBoilerplateRenderInline.
//
// Parameters:
//   - cliOutputPath: The base output path from CLI flag
//   - apiOutputPath: Optional subdirectory from API request (validated for security)
//
// Returns the absolute output directory path or an error.
func prepareOutputDirectory(cliOutputPath string, apiOutputPath *string) (string, error) {
	// Determine the final output directory path
	outputDir, err := determineOutputDirectory(cliOutputPath, apiOutputPath)
	if err != nil {
		return "", fmt.Errorf("failed to determine output directory: %w", err)
	}

	// Create the output directory if it doesn't exist
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create output directory: %w", err)
	}

	return outputDir, nil
}

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

		if req.TemplateID == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "templateId is required",
			})
			return
		}

		// Extract the directory from the baseRunbookPath (which we assume is a file path)
		runbookDir := filepath.Dir(runbookPath)

		// Construct the full template path
		fullTemplatePath := filepath.Join(runbookDir, req.TemplatePath)
		slog.Info("Rendering boilerplate template", "baseDir", runbookDir, "req.TemplatePath", req.TemplatePath, "fullTemplatePath", fullTemplatePath, "templateId", req.TemplateID)

		// Check if the template directory exists
		if _, err := os.Stat(fullTemplatePath); os.IsNotExist(err) {
			slog.Error("Template directory not found", "path", fullTemplatePath)
			c.JSON(http.StatusNotFound, gin.H{
				"error":   "Template directory not found",
				"details": "Tried to access: " + fullTemplatePath,
			})
			return
		}

		// Prepare the output directory (determine path and create it)
		outputDir, err := prepareOutputDirectory(cliOutputPath, req.OutputPath)
		if err != nil {
			slog.Error("Failed to prepare output directory", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to prepare output directory",
				"details": err.Error(),
			})
			return
		}

		slog.Info("Rendering template to output directory", "outputDir", outputDir)

		// Render with manifest tracking for smart file cleanup
		diff, err := RenderWithManifest(req.TemplateID, func() (string, error) {
			// Render to a temp directory
			tempDir, tempErr := os.MkdirTemp("", "boilerplate-render-*")
			if tempErr != nil {
				return "", fmt.Errorf("failed to create temp directory: %w", tempErr)
			}

			// Render the template to temp directory
			if renderErr := renderBoilerplateTemplate(fullTemplatePath, tempDir, req.Variables); renderErr != nil {
				if cleanupErr := os.RemoveAll(tempDir); cleanupErr != nil {
					slog.Warn("Failed to clean up temp directory after render error",
						"tempDir", tempDir, "cleanupErr", cleanupErr)
				}
				return "", renderErr
			}

			return tempDir, nil
		}, outputDir)

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

		// Create response with file tree and cleanup info
		response := RenderResponse{
			Message:      "Template rendered successfully to output directory",
			OutputDir:    outputDir,
			TemplatePath: fullTemplatePath,
			FileTree:     fileTree,
		}

		// Include diff information if manifest tracking was used
		if diff != nil {
			response.DeletedFiles = diff.Orphaned
			response.CreatedFiles = diff.Created
			response.ModifiedFiles = diff.Modified
			response.SkippedFiles = diff.Unchanged
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
func HandleBoilerplateRenderInline(cliOutputPath string) gin.HandlerFunc {
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

		// Always render to a temp directory first for inline templates.
		// This prevents boilerplate from clearing existing files in the persistent output.
		tempOutputDir, err := os.MkdirTemp("", "boilerplate-output-*")
		if err != nil {
			slog.Error("Failed to create temp output directory", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to create output directory",
				"details": err.Error(),
			})
			return
		}
		defer os.RemoveAll(tempOutputDir)
		slog.Info("Created temporary output directory", "outputDir", tempOutputDir)

		// Render the template to the temp directory
		err = renderBoilerplateTemplate(tempDir, tempOutputDir, req.Variables)
		if err != nil {
			slog.Error("Failed to render boilerplate template", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to render template",
				"details": err.Error(),
			})
			return
		}

		slog.Info("Successfully rendered boilerplate template")

		// Read all rendered files from the temp output directory
		renderedFiles, err := readAllFilesInDirectory(tempOutputDir)
		if err != nil {
			slog.Error("Failed to read rendered files", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to read rendered files",
				"details": err.Error(),
			})
			return
		}

		// If generateFile is true, copy rendered files to the persistent output directory
		// This merges with existing files instead of replacing them
		var persistentOutputDir string
		if req.GenerateFile {
			persistentOutputDir, err = prepareOutputDirectory(cliOutputPath, nil)
			if err != nil {
				slog.Error("Failed to prepare output directory", "error", err)
				c.JSON(http.StatusInternalServerError, gin.H{
					"error":   "Failed to prepare output directory",
					"details": err.Error(),
				})
				return
			}

			// Copy each rendered file to the persistent output (merging with existing files)
			for relPath, file := range renderedFiles {
				fullPath := filepath.Join(persistentOutputDir, relPath)
				
				// Create parent directories if needed
				if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
					slog.Error("Failed to create directory", "path", filepath.Dir(fullPath), "error", err)
					c.JSON(http.StatusInternalServerError, gin.H{
						"error":   "Failed to create directory structure",
						"details": err.Error(),
					})
					return
				}

				if err := os.WriteFile(fullPath, []byte(file.Content), 0644); err != nil {
					slog.Error("Failed to write file", "path", fullPath, "error", err)
					c.JSON(http.StatusInternalServerError, gin.H{
						"error":   "Failed to write file",
						"details": err.Error(),
					})
					return
				}
				slog.Debug("Copied file to persistent output", "path", fullPath)
			}
			slog.Info("Successfully copied files to persistent output", "outputDir", persistentOutputDir)
		}

		// Build file tree - use persistent dir if files were generated, otherwise temp
		fileTreeDir := tempOutputDir
		if persistentOutputDir != "" {
			fileTreeDir = persistentOutputDir
		}
		fileTree, err := buildFileTreeWithRoot(fileTreeDir, "")
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
// Variables can be simple strings or nested structures (like _blocks for block outputs)
func renderBoilerplateContent(content string, variables map[string]any) (string, error) {
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

	// Render using boilerplate (variables are already map[string]any)
	if err := renderBoilerplateTemplate(tempDir, outputDir, variables); err != nil {
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
