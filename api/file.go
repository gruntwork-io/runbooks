package api

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
)

// FileRequest represents the request body for the file endpoint
type FileRequest struct {
	Path string `json:"path"`
}

// Return the contents of the runbook file directly.
// This handler is used for GET /api/runbook requests.
// remoteSourceURL is the original remote URL (e.g., GitHub URL) if the runbook was fetched remotely; empty for local runbooks.
func HandleRunbookRequest(runbookPath string, isWatchMode bool, useExecutableRegistry bool, remoteSourceURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Use the runbook path directly
		filePath := runbookPath
		serveFileContentWithWatchMode(c, filePath, isWatchMode, useExecutableRegistry, remoteSourceURL)
	}
}

// Return the contents of a file at the given path.
// The path is expected to be a file path, not a directory.
// This handler is used for POST /api/file requests with JSON body.
func HandleFileRequest(runbookPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req FileRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid request",
				"details": "Request body must be valid JSON with a 'path' field",
			})
			return
		}

		// Compute the full path: use runbook path directly or join with relative path
		filePath := runbookPath
		if req.Path != "" {
			filePath = filepath.Join(filepath.Dir(runbookPath), req.Path)
		}
		serveFileContent(c, filePath)
	}
}

// HandleRunbookAssetsRequest serves static assets from the runbook's assets directory
// This endpoint serves raw files (images, PDFs, media) with appropriate content types
func HandleRunbookAssetsRequest(runbookPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Get the requested file path from the URL parameter
		requestedPath := c.Param("filepath")
		if requestedPath == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid request",
				"details": "No file path provided",
			})
			return
		}

		// Remove leading slash if present
		if requestedPath[0] == '/' {
			requestedPath = requestedPath[1:]
		}

		// Clean the path to prevent directory traversal attacks
		cleanPath := filepath.Clean(requestedPath)
		
		// Ensure the clean path doesn't try to escape (no ".." allowed)
		if filepath.IsAbs(cleanPath) || len(cleanPath) > 0 && cleanPath[0] == '.' {
			c.JSON(http.StatusForbidden, gin.H{
				"error":   "Invalid path",
				"details": "Path must be relative and cannot contain '..'",
			})
			return
		}

		// Check if the file extension is allowed (security whitelist)
		if !isAllowedAssetExtension(cleanPath) {
			c.JSON(http.StatusForbidden, gin.H{
				"error":   "File type not allowed",
				"details": "Only image, PDF, and media files are allowed",
			})
			return
		}

		// Get the runbook directory
		runbookDir := filepath.Dir(runbookPath)
		
		// Construct the full path: <runbook-dir>/assets/<requested-path>
		fullPath := filepath.Join(runbookDir, "assets", cleanPath)

		// Verify the resolved path is still within the assets directory (additional safety check)
		assetsDir := filepath.Join(runbookDir, "assets")
		relPath, err := filepath.Rel(assetsDir, fullPath)
		if err != nil || len(relPath) >= 2 && relPath[0:2] == ".." {
			c.JSON(http.StatusForbidden, gin.H{
				"error":   "Invalid path",
				"details": "Path must be within the assets directory",
			})
			return
		}

		// Check if the file exists
		fileInfo, err := os.Stat(fullPath)
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{
				"error":   "File not found",
				"details": "The requested asset was not found",
			})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to access file",
				"details": err.Error(),
			})
			return
		}

		// Ensure it's not a directory
		if fileInfo.IsDir() {
			c.JSON(http.StatusForbidden, gin.H{
				"error":   "Invalid request",
				"details": "Cannot serve directories",
			})
			return
		}

		// Set the appropriate content type based on file extension
		contentType := getContentType(cleanPath)
		c.Header("Content-Type", contentType)

		// Serve the file
		c.File(fullPath)
	}
}

// isAllowedAssetExtension checks if the file extension is in the whitelist of allowed types
func isAllowedAssetExtension(filename string) bool {
	ext := filepath.Ext(filename)
	allowedExtensions := map[string]bool{
		// Images
		".png":  true,
		".jpg":  true,
		".jpeg": true,
		".gif":  true,
		".svg":  true,
		".webp": true,
		".bmp":  true,
		".ico":  true,
		// Documents
		".pdf": true,
		// Media
		".mp4":  true,
		".webm": true,
		".ogg":  true,
		".mp3":  true,
		".wav":  true,
		".m4a":  true,
		".avi":  true,
		".mov":  true,
	}
	return allowedExtensions[ext]
}

// getContentType returns the MIME type for a file based on its extension
func getContentType(filename string) string {
	ext := filepath.Ext(filename)
	contentTypes := map[string]string{
		// Images
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".svg":  "image/svg+xml",
		".webp": "image/webp",
		".bmp":  "image/bmp",
		".ico":  "image/x-icon",
		// Documents
		".pdf": "application/pdf",
		// Media
		".mp4":  "video/mp4",
		".webm": "video/webm",
		".ogg":  "video/ogg",
		".mp3":  "audio/mpeg",
		".wav":  "audio/wav",
		".m4a":  "audio/mp4",
		".avi":  "video/x-msvideo",
		".mov":  "video/quicktime",
	}
	
	if contentType, ok := contentTypes[ext]; ok {
		return contentType
	}
	return "application/octet-stream"
}

// serveFileContent is a helper function that serves file content
func serveFileContent(c *gin.Context, filePath string) {
	serveFileContentWithWatchMode(c, filePath, false, true, "")
}

// serveFileContentWithWatchMode is a helper function that serves file content with optional watch mode info.
// remoteSourceURL is included in the response when non-empty, allowing the frontend to display the original URL.
func serveFileContentWithWatchMode(c *gin.Context, filePath string, isWatchMode bool, useExecutableRegistry bool, remoteSourceURL string) {
	// Check if the file exists
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{
			"error":   "File not found",
			"details": "The file at the path " + filePath + " was not found.",
		})
		return
	}

	// Read the file contents
	file, err := os.Open(filePath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to open file",
			"details": "The file at the path " + filePath + " could not be opened.",
		})
		return
	}
	defer file.Close()

	// Read all content
	content, err := io.ReadAll(file)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to read file",
			"details": "The file at the path " + filePath + " could not be read.",
		})
		return
	}

	// Get file info for size and language detection
	fileInfo, err := os.Stat(filePath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to get file info",
			"details": "Could not get file information for " + filePath,
		})
		return
	}

	// Build response with common fields
	response := gin.H{
		"path":                  filePath,
		"content":               string(content),
		"contentHash":           computeContentHash(string(content)),
		"language":              getLanguageFromExtension(filepath.Base(filePath)),
		"size":                  fileInfo.Size(),
		"useExecutableRegistry": useExecutableRegistry,
	}

	// Add watch mode info if provided
	if isWatchMode {
		response["isWatchMode"] = true
	}

	// Add remote source URL if this runbook was fetched from a remote source
	if remoteSourceURL != "" {
		response["remoteSource"] = remoteSourceURL
	}

	// In live-reload mode, validate for duplicate components on-demand
	// (In registry mode, warnings are captured once at server startup during registry creation.
	// In live-reload mode, no registry exists, so we validate on each request for the runbook.)
	if !useExecutableRegistry {
		warnings, err := validateRunbook(filePath)
		if err != nil {
			// Log error but don't fail the request
			slog.Warn("Failed to validate runbook for duplicates", "error", err)
		} else {
			response["warnings"] = warnings
		}
	}

	c.JSON(http.StatusOK, response)
}
