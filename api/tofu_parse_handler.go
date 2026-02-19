package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
)

// TofuParseRequest is the request body for POST /api/tofu/parse.
type TofuParseRequest struct {
	ModulePath string `json:"modulePath" binding:"required"`
}

// HandleTofuModuleParse parses a .tf module directory and returns a BoilerplateConfig JSON.
// This endpoint allows the <TfModule> frontend component to dynamically parse OpenTofu
// modules at runtime instead of requiring pre-generated boilerplate.yml files.
func HandleTofuModuleParse(runbookPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req TofuParseRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			slog.Error("Failed to parse tofu parse request", "error", err)
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid request body",
				"details": err.Error(),
			})
			return
		}

		// Resolve modulePath relative to the runbook directory
		runbookDir := filepath.Dir(runbookPath)
		absModulePath := filepath.Join(runbookDir, req.ModulePath)

		// Validate the path exists and is a directory
		info, err := os.Stat(absModulePath)
		if err != nil {
			slog.Error("Module path not found", "path", absModulePath, "error", err)
			c.JSON(http.StatusNotFound, gin.H{
				"error":   "Module directory not found",
				"details": fmt.Sprintf("Could not find module at: %s", req.ModulePath),
			})
			return
		}
		if !info.IsDir() {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Path is not a directory",
				"details": fmt.Sprintf("Expected a directory containing .tf files, got a file: %s", req.ModulePath),
			})
			return
		}

		// Parse the OpenTofu module
		vars, err := ParseTofuModule(absModulePath)
		if err != nil {
			slog.Error("Failed to parse OpenTofu module", "path", absModulePath, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to parse OpenTofu module",
				"details": err.Error(),
			})
			return
		}

		// Convert to BoilerplateConfig
		config := MapToBoilerplateConfig(vars)

		slog.Info("Successfully parsed OpenTofu module", "path", absModulePath, "variableCount", len(config.Variables))
		c.JSON(http.StatusOK, config)
	}
}
