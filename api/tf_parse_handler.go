package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
)

// tfRemoteCloneSem limits concurrent remote git clones for TF module parsing
// to prevent disk/network exhaustion from many simultaneous requests.
var tfRemoteCloneSem = make(chan struct{}, 3)

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

// Sentinel errors returned by ParseTfModule so callers can map to the
// right transport-specific response (HTTP status code, IPC error, etc.).
var (
	ErrTfResolve  = fmt.Errorf("failed to resolve module source")
	ErrTfNotFound = fmt.Errorf("module directory not found")
	ErrTfNotDir   = fmt.Errorf("path is not a directory")
	ErrTfParse    = fmt.Errorf("failed to parse OpenTofu module")
)

// ParseTfModuleRequest is the transport-agnostic core of the tf-parse
// flow. It resolves the module source (local path relative to the
// gruntbook, or a remote git URL cloned to a temp dir), parses the .tf
// files, and returns the boilerplate-shaped response. Callers map the
// sentinel errors onto their transport.
func ParseTfModuleRequest(req TfParseRequest, gruntbookPath string, tokens *TokenResolver) (*TfParseResponse, error) {
	modulePath, cleanup, err := resolveModuleSource(req.Source, gruntbookPath, tokens)
	if err != nil {
		slog.Error("Failed to resolve module source", "source", req.Source, "error", err)
		return nil, fmt.Errorf("%w: %v", ErrTfResolve, err)
	}
	if cleanup != nil {
		defer cleanup()
	}

	info, err := os.Stat(modulePath)
	if err != nil {
		slog.Error("Module path not found", "path", modulePath, "error", err)
		return nil, fmt.Errorf("%w: could not find module at %s", ErrTfNotFound, req.Source)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%w: expected a directory containing .tf files, got a file at %s", ErrTfNotDir, req.Source)
	}

	vars, metadata, err := ParseTfModuleFull(modulePath)
	if err != nil {
		slog.Error("Failed to parse OpenTofu module", "path", modulePath, "error", err)
		return nil, fmt.Errorf("%w: %v", ErrTfParse, err)
	}

	config := MapToBoilerplateConfig(vars)
	slog.Info("Successfully parsed OpenTofu/Terraform module",
		"source", req.Source,
		"resolvedPath", modulePath,
		"variableCount", len(config.Variables),
		"outputCount", len(metadata.OutputNames),
		"resourceCount", len(metadata.ResourceNames),
	)
	return &TfParseResponse{
		BoilerplateConfig: config,
		Metadata:          metadata,
	}, nil
}

// HandleTfModuleParse parses a .tf module directory and returns a BoilerplateConfig JSON
// with additional module metadata (folder name, README title, outputs, resources).
// The source can be a local path (resolved relative to the gruntbook directory) or a remote
// git URL (cloned to a temp directory, parsed, then cleaned up).
func HandleTfModuleParse(gruntbookPath string, tokens *TokenResolver) gin.HandlerFunc {
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

		resp, err := ParseTfModuleRequest(req, gruntbookPath, tokens)
		if err != nil {
			status, msg := tfErrorStatus(err)
			c.JSON(status, gin.H{
				"error":   msg,
				"details": err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, resp)
	}
}

// tfErrorStatus maps ParseTfModule sentinel errors to an HTTP response.
func tfErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, ErrTfResolve):
		return http.StatusBadRequest, "Failed to resolve module source"
	case errors.Is(err, ErrTfNotFound):
		return http.StatusNotFound, "Module directory not found"
	case errors.Is(err, ErrTfNotDir):
		return http.StatusBadRequest, "Path is not a directory"
	case errors.Is(err, ErrTfParse):
		return http.StatusInternalServerError, "Failed to parse OpenTofu module"
	default:
		return http.StatusInternalServerError, "Failed to parse tf module"
	}
}

// resolveModuleSource resolves a module source string to a local filesystem path.
// For local paths, resolves relative to the gruntbook directory.
// For remote URLs, clones to a temp directory and returns a cleanup function.
//
// tokens may be nil for callers that never pass remote URLs (e.g., unit
// tests covering only the local-path branches).
func resolveModuleSource(source string, gruntbookPath string, tokens *TokenResolver) (localPath string, cleanup func(), err error) {
	parsed, err := ParseRemoteSource(source)
	if err != nil {
		return "", nil, fmt.Errorf("invalid module source %q: %w", source, err)
	}

	// Local path — resolve relative to the gruntbook directory (unless already absolute).
	// Paths with ".." (e.g., "../modules/vpc") are intentionally allowed: the source value
	// comes from trusted gruntbook content, and this endpoint requires session auth, which
	// already grants access to arbitrary command execution via /api/exec.
	if parsed == nil {
		if filepath.IsAbs(source) {
			return source, nil, nil
		}
		gruntbookDir := filepath.Dir(gruntbookPath)
		return filepath.Join(gruntbookDir, source), nil, nil
	}

	// Remote URL — acquire concurrency slot, then clone to temp directory
	select {
	case tfRemoteCloneSem <- struct{}{}:
		// acquired
	default:
		return "", nil, fmt.Errorf("too many concurrent remote module clones; try again shortly")
	}
	releaseSem := func() { <-tfRemoteCloneSem }

	var token string
	if tokens != nil {
		token = tokens.TokenForHost(parsed.Host)
	}
	if err := parsed.Resolve(token); err != nil {
		releaseSem()
		return "", nil, fmt.Errorf("failed to resolve remote ref: %w", err)
	}

	tempDir, err := os.MkdirTemp("", "tfmodule-remote-*")
	if err != nil {
		releaseSem()
		return "", nil, fmt.Errorf("failed to create temp directory: %w", err)
	}
	cleanup = func() {
		os.RemoveAll(tempDir)
		releaseSem()
	}

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
