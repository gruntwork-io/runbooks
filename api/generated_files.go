package api

import (
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

// HandleGeneratedFilesCheck returns a handler that checks if files exist in the output directory
func HandleGeneratedFilesCheck(rawOutputPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		dirInfo, err := validateAndGetOutputDirectory(rawOutputPath)
		if err != nil {
			slog.Error("Failed to validate output directory", "error", err, "outputPath", rawOutputPath)

			// Get the current working directory for the error message
			cwd, cwdErr := os.Getwd()
			if cwdErr != nil {
				cwd = "(unknown)"
			}

			c.JSON(http.StatusInternalServerError, gin.H{
				"error":              "Failed to validate output directory",
				"details":            err.Error(),
				"specifiedPath":      rawOutputPath,
				"currentWorkingDir":  cwd,
			})
			return
		}

		c.JSON(http.StatusOK, GeneratedFilesCheckResponse{
			HasFiles:           dirInfo.fileCount > 0,
			AbsoluteOutputPath: dirInfo.absoluteOutputPath,
			RelativeOutputPath: rawOutputPath,
			FileCount:          dirInfo.fileCount,
		})
	}
}

// HandleGeneratedFilesDelete returns a handler that deletes all files in the output directory
func HandleGeneratedFilesDelete(rawOutputPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		dirInfo, err := validateAndGetOutputDirectory(rawOutputPath)
		if err != nil {
			slog.Error("Failed to validate output directory", "error", err, "outputPath", rawOutputPath)
			// Determine appropriate status code based on error type
			statusCode := http.StatusInternalServerError
			if strings.Contains(err.Error(), "output path is not valid") {
				statusCode = http.StatusForbidden
			}
			c.JSON(statusCode, gin.H{
				"error":   "Failed to validate output directory",
				"details": err.Error(),
			})
			return
		}

		if !dirInfo.exists {
			c.JSON(http.StatusOK, GeneratedFilesDeleteResponse{
				Success:      true,
				DeletedCount: 0,
				Message:      "Output directory does not exist, nothing to delete",
			})
			return
		}

		// Delete all contents of the directory (but not the directory itself)
		err = deleteDirectoryContents(dirInfo.absoluteOutputPath)
		if err != nil {
			slog.Error("Failed to delete directory contents", "error", err, "path", dirInfo.absoluteOutputPath)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to delete files",
				"details": err.Error(),
			})
			return
		}

		slog.Info("Successfully deleted generated files", "path", dirInfo.absoluteOutputPath, "count", dirInfo.fileCount)
		c.JSON(http.StatusOK, GeneratedFilesDeleteResponse{
			Success:      true,
			DeletedCount: dirInfo.fileCount,
			Message:      fmt.Sprintf("Successfully deleted %d file(s) from %s", dirInfo.fileCount, dirInfo.absoluteOutputPath),
		})
	}
}

// validateAndGetOutputDirectory validates the output path and retrieves its information.
// Returns outputDirInfo and any error encountered.
func validateAndGetOutputDirectory(rawOutputPath string) (*outputDirInfo, error) {
	// Resolve the output path to absolute
	absoluteOutputPath, err := resolveToAbsolutePath(rawOutputPath)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve output path: %w", err)
	}

	// Validate the output path
	if err := ValidateAbsolutePathInCwd(absoluteOutputPath); err != nil {
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
// Relative paths are resolved relative to the current working directory.
// Absolute paths are returned unchanged. Returns an error if the path is empty.
// On macOS, symlinks in the CWD are resolved (e.g., /tmp -> /private/tmp).
func resolveToAbsolutePath(rawPath string) (string, error) {
	if rawPath == "" {
		return "", fmt.Errorf("path cannot be empty")
	}

	// If path is already absolute, return it
	if filepath.IsAbs(rawPath) {
		return rawPath, nil
	}

	// Otherwise, make it relative to the current working directory
	currentDir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get current working directory: %w", err)
	}

	// Resolve symlinks in the CWD (e.g., on macOS /tmp -> /private/tmp)
	// This ensures consistent paths even when the output directory doesn't exist yet
	resolvedDir, err := filepath.EvalSymlinks(currentDir)
	if err != nil {
		// If we can't resolve symlinks on the CWD, it's a sign of a problem.
		// It's better to fail fast than to proceed with a potentially incorrect path.
		return "", fmt.Errorf("failed to resolve symlinks for current working directory %q: %w", currentDir, err)
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
func deleteDirectoryContents(absolutePath string) error {
	// Just to be sure, validate that the path is safe to delete
	if err := ValidateAbsolutePathInCwd(absolutePath); err != nil {
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
