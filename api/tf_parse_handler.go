package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
)

// TfParseRequest is the request body for POST /api/tf/parse.
type TfParseRequest struct {
	// Source can be a local relative path (e.g., "../modules/vpc") or a remote URL
	// in any format supported by ParseRemoteSource (GitHub shorthand, git:: prefix,
	// GitHub/GitLab browser URLs).
	Source string `json:"source" binding:"required"`
}

// TfParseResponse extends BoilerplateConfig with module-level metadata.
// The variables, sections, and outputDependencies fields come from BoilerplateConfig.
// The module metadata fields are additional.
type TfParseResponse struct {
	*BoilerplateConfig
	Metadata TfModuleMetadata `json:"metadata"`
}

// HandleTfModuleParse parses a .tf module directory and returns a BoilerplateConfig JSON
// with additional module metadata (folder name, README title, outputs, resources).
// The source can be a local path (resolved relative to the runbook directory) or a remote
// git URL (cloned to a temp directory, parsed, then cleaned up).
func HandleTfModuleParse(runbookPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req TfParseRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			slog.Error("Failed to parse tf parse request", "error", err)
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid request body",
				"details": err.Error(),
			})
			return
		}

		// Determine if this is a remote URL or a local path
		modulePath, cleanup, err := resolveModuleSource(req.Source, runbookPath)
		if err != nil {
			slog.Error("Failed to resolve module source", "source", req.Source, "error", err)
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Failed to resolve module source",
				"details": err.Error(),
			})
			return
		}
		if cleanup != nil {
			defer cleanup()
		}

		// Validate the path exists and is a directory
		info, err := os.Stat(modulePath)
		if err != nil {
			slog.Error("Module path not found", "path", modulePath, "error", err)
			c.JSON(http.StatusNotFound, gin.H{
				"error":   "Module directory not found",
				"details": fmt.Sprintf("Could not find module at: %s", req.Source),
			})
			return
		}
		if !info.IsDir() {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Path is not a directory",
				"details": fmt.Sprintf("Expected a directory containing .tf files, got a file: %s", req.Source),
			})
			return
		}

		// Parse the OpenTofu module (single pass for both variables and metadata)
		vars, metadata, err := ParseTfModuleFull(modulePath)
		if err != nil {
			slog.Error("Failed to parse OpenTofu module", "path", modulePath, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to parse OpenTofu module",
				"details": err.Error(),
			})
			return
		}

		config := MapToBoilerplateConfig(vars)

		slog.Info("Successfully parsed OpenTofu module",
			"source", req.Source,
			"resolvedPath", modulePath,
			"variableCount", len(config.Variables),
			"outputCount", len(metadata.OutputNames),
			"resourceCount", len(metadata.ResourceNames),
		)
		c.JSON(http.StatusOK, TfParseResponse{
			BoilerplateConfig: config,
			Metadata:          metadata,
		})
	}
}

// resolveModuleSource resolves a module source string to a local filesystem path.
// For local paths, resolves relative to the runbook directory.
// For remote URLs, clones to a temp directory and returns a cleanup function.
func resolveModuleSource(source string, runbookPath string) (localPath string, cleanup func(), err error) {
	parsed, err := ParseRemoteSource(source)
	if err != nil {
		return "", nil, fmt.Errorf("invalid module source %q: %w", source, err)
	}

	// Local path — resolve relative to the runbook directory (unless already absolute)
	if parsed == nil {
		if filepath.IsAbs(source) {
			return source, nil, nil
		}
		runbookDir := filepath.Dir(runbookPath)
		return filepath.Join(runbookDir, source), nil, nil
	}

	// Remote URL — clone to temp directory
	token := GetTokenForHost(parsed.Host)
	if err := parsed.Resolve(token); err != nil {
		return "", nil, fmt.Errorf("failed to resolve remote ref: %w", err)
	}

	tempDir, err := os.MkdirTemp("", "tfmodule-remote-*")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create temp directory: %w", err)
	}
	cleanup = func() { os.RemoveAll(tempDir) }

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	cloneURL := InjectGitToken(parsed.CloneURL, token)
	slog.Info("Cloning remote module", "host", parsed.Host, "owner", parsed.Owner, "repo", parsed.Repo, "ref", parsed.Ref, "path", parsed.Path)

	var cloneErr error
	if parsed.Path != "" {
		_, cloneErr = GitSparseCloneSimple(ctx, cloneURL, tempDir, parsed.Path, parsed.Ref)
	} else {
		_, cloneErr = GitCloneSimple(ctx, cloneURL, tempDir, parsed.Ref)
	}
	if cloneErr != nil {
		cleanup()
		return "", nil, fmt.Errorf("failed to clone remote module: %w", cloneErr)
	}

	// Build the local path within the cloned repo
	modulePath := tempDir
	if parsed.Path != "" {
		modulePath = filepath.Join(tempDir, parsed.Path)
	}

	return modulePath, cleanup, nil
}
