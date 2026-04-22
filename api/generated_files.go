package api

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// This file provides HTTP handlers for managing generated files in the output directory.
// It handles checking if files already exist and deleting them when requested by the user,
// with validation to ensure operations are safe and confined to the configured output path.

// outputDirInfo contains validated information about the output directory
type outputDirInfo struct {
	absoluteOutputPath string
	fileCount          int
	exists             bool
}

// CheckGeneratedFiles is the transport-agnostic core of the
// generated-files check flow: resolves and validates the output
// directory, then counts its files.
func CheckGeneratedFiles(workingDir, rawOutputPath string) (*GeneratedFilesCheckResponse, error) {
	dirInfo, err := validateAndGetOutputDirectory(workingDir, rawOutputPath)
	if err != nil {
		slog.Error("Failed to validate output directory", "error", err, "outputPath", rawOutputPath, "workingDir", workingDir)
		return nil, fmt.Errorf("failed to validate output directory: %w", err)
	}
	return &GeneratedFilesCheckResponse{
		HasFiles:           dirInfo.fileCount > 0,
		AbsoluteOutputPath: dirInfo.absoluteOutputPath,
		RelativeOutputPath: rawOutputPath,
		FileCount:          dirInfo.fileCount,
	}, nil
}

// ErrOutputPathInvalid signals that the output path fails the
// under-working-dir validation (typically because it escapes the
// workspace via .. or an absolute path outside it). The HTTP handler
// maps this to 403.
var ErrOutputPathInvalid = fmt.Errorf("output path is not valid")

// DeleteGeneratedFiles is the transport-agnostic core of the
// generated-files delete flow. It validates the output path, and if
// the directory exists, removes its contents (but not the directory
// itself). Non-existent directories return a successful, no-op
// response so the frontend UX stays simple.
func DeleteGeneratedFiles(workingDir, rawOutputPath string) (*GeneratedFilesDeleteResponse, error) {
	dirInfo, err := validateAndGetOutputDirectory(workingDir, rawOutputPath)
	if err != nil {
		slog.Error("Failed to validate output directory", "error", err, "outputPath", rawOutputPath)
		if strings.Contains(err.Error(), "output path is not valid") {
			return nil, fmt.Errorf("%w: %v", ErrOutputPathInvalid, err)
		}
		return nil, fmt.Errorf("failed to validate output directory: %w", err)
	}

	if !dirInfo.exists {
		return &GeneratedFilesDeleteResponse{
			Success:      true,
			DeletedCount: 0,
			Message:      "Output directory does not exist, nothing to delete",
		}, nil
	}

	if err := deleteDirectoryContents(dirInfo.absoluteOutputPath, workingDir); err != nil {
		slog.Error("Failed to delete directory contents", "error", err, "path", dirInfo.absoluteOutputPath)
		return nil, fmt.Errorf("failed to delete files: %w", err)
	}

	slog.Info("Successfully deleted generated files", "path", dirInfo.absoluteOutputPath, "count", dirInfo.fileCount)
	return &GeneratedFilesDeleteResponse{
		Success:      true,
		DeletedCount: dirInfo.fileCount,
		Message:      fmt.Sprintf("Successfully deleted %d file(s) from %s", dirInfo.fileCount, dirInfo.absoluteOutputPath),
	}, nil
}

// HandleGeneratedFilesCheck returns a handler that checks if files exist in the output directory
func HandleGeneratedFilesCheck(workingDir string, rawOutputPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		resp, err := CheckGeneratedFiles(workingDir, rawOutputPath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":         "Failed to validate output directory",
				"details":       err.Error(),
				"specifiedPath": rawOutputPath,
				"workingDir":    workingDir,
			})
			return
		}
		c.JSON(http.StatusOK, resp)
	}
}

// HandleGeneratedFilesDelete returns a handler that deletes all files in the output directory
func HandleGeneratedFilesDelete(workingDir string, rawOutputPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		resp, err := DeleteGeneratedFiles(workingDir, rawOutputPath)
		if err != nil {
			status := http.StatusInternalServerError
			msg := "Failed to validate output directory"
			if errors.Is(err, ErrOutputPathInvalid) {
				status = http.StatusForbidden
			} else if strings.Contains(err.Error(), "failed to delete files") {
				msg = "Failed to delete files"
			}
			c.JSON(status, gin.H{
				"error":   msg,
				"details": err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, resp)
	}
}

// validateAndGetOutputDirectory validates the output path and retrieves its information.
// Returns outputDirInfo and any error encountered.
func validateAndGetOutputDirectory(workingDir string, rawOutputPath string) (*outputDirInfo, error) {
	// Resolve the output path to absolute
	absoluteOutputPath, err := resolveToAbsolutePath(workingDir, rawOutputPath)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve output path: %w", err)
	}

	// Validate the output path against the working directory (not process CWD).
	// For remote gruntbooks, the working dir is a temp dir, not the process CWD.
	if err := ValidateAbsolutePathInDir(absoluteOutputPath, workingDir); err != nil {
		return nil, err
	}

	// Check if directory exists
	info, err := os.Stat(absoluteOutputPath)
	if os.IsNotExist(err) {
		return &outputDirInfo{
			absoluteOutputPath: absoluteOutputPath,
			fileCount:          0,
			exists:             false,
		}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to stat output directory: %w", err)
	}

	// Verify it's a directory
	if !info.IsDir() {
		return nil, fmt.Errorf("path exists but is not a directory: %s", absoluteOutputPath)
	}

	// Count files in the directory
	fileCount, err := countFilesInDirectory(absoluteOutputPath)
	if err != nil {
		return nil, fmt.Errorf("failed to count files: %w", err)
	}

	return &outputDirInfo{
		absoluteOutputPath: absoluteOutputPath,
		fileCount:          fileCount,
		exists:             true,
	}, nil
}

// resolveToAbsolutePath converts a file path to its absolute form.
// Relative paths are resolved relative to the provided working directory.
// Absolute paths are returned unchanged. Returns an error if the path is empty.
// On macOS, symlinks in the working directory are resolved (e.g., /tmp -> /private/tmp).
func resolveToAbsolutePath(workingDir string, rawPath string) (string, error) {
	if rawPath == "" {
		return "", fmt.Errorf("path cannot be empty")
	}

	// If path is already absolute, return it
	if filepath.IsAbs(rawPath) {
		return rawPath, nil
	}

	// Resolve symlinks in the working directory (e.g., on macOS /tmp -> /private/tmp)
	// This ensures consistent paths even when the output directory doesn't exist yet
	resolvedDir, err := filepath.EvalSymlinks(workingDir)
	if err != nil {
		// If we can't resolve symlinks on the working directory, it's a sign of a problem.
		// It's better to fail fast than to proceed with a potentially incorrect path.
		return "", fmt.Errorf("failed to resolve symlinks for working directory %q: %w", workingDir, err)
	}

	return filepath.Join(resolvedDir, rawPath), nil
}

// countFilesInDirectory counts all files (not directories) in a directory recursively
func countFilesInDirectory(absolutePath string) (int, error) {
	count := 0

	err := filepath.Walk(absolutePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		// Only count files, not directories
		if !info.IsDir() {
			count++
		}
		return nil
	})

	if err != nil {
		return 0, fmt.Errorf("failed to walk directory: %w", err)
	}

	return count, nil
}

// deleteDirectoryContents deletes all files and subdirectories within a directory,
// but preserves the directory itself
func deleteDirectoryContents(absolutePath string, workingDir string) error {
	// Just to be sure, validate that the path is safe to delete
	if err := ValidateAbsolutePathInDir(absolutePath, workingDir); err != nil {
		return fmt.Errorf("failed to validate output path as safe to delete: %w", err)
	}

	entries, err := os.ReadDir(absolutePath)
	if err != nil {
		return fmt.Errorf("failed to read directory: %w", err)
	}

	for _, entry := range entries {
		entryPath := filepath.Join(absolutePath, entry.Name())
		err := os.RemoveAll(entryPath)
		if err != nil {
			return fmt.Errorf("failed to delete %s: %w", entryPath, err)
		}
	}

	return nil
}
