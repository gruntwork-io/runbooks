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

// This handler renders a boilerplate template with the provided variables.

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
	FileTree     []CodeFileData `json:"fileTree"`
}

// HandleBoilerplateRender renders a boilerplate template with the provided variables
func HandleBoilerplateRender(runbookPath string) gin.HandlerFunc {
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
		var outputDir string
		if req.OutputPath != nil && *req.OutputPath != "" {
			// Use the provided output path (can be relative or absolute)
			outputDir = *req.OutputPath
		} else {
			// Default to "generated" subfolder in current working directory
			currentDir, err := os.Getwd()
			if err != nil {
				slog.Error("Failed to get current working directory", "error", err)
				c.JSON(http.StatusInternalServerError, gin.H{
					"error":   "Failed to get current working directory",
					"details": err.Error(),
				})
				return
			}
			outputDir = filepath.Join(currentDir, "generated")
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
		err := renderBoilerplateTemplate(fullTemplatePath, outputDir, req.Variables)
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
		fileTree, err := buildFileTree(outputDir, "")
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
