package api

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
)

// ResolvedRunbook represents a runbook that has been located and is ready to serve.
// For local runbooks, RemoteSourceURL is empty.
// For remote runbooks, the content has already been downloaded to LocalPath.
type ResolvedRunbook struct {
	LocalPath       string
	RemoteSourceURL string // original URL (e.g., GitHub URL); empty for local runbooks
}

// FileRequest represents the request body for the file endpoint
type FileRequest struct {
	Path string `json:"path"`
}

// HandleRunbookRequest returns the contents of the runbook file directly.
// This handler is used for GET /api/runbook requests.
func HandleRunbookRequest(runbook ResolvedRunbook, isWatchMode bool, useExecutableRegistry bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Read the file
		content, fileInfo, err := readFileContent(runbook.LocalPath)
		if err != nil {
			handleFileError(c, runbook.LocalPath, err)
			return
		}

		// Build the response
		response := buildRunbookResponse(runbook, string(content), fileInfo, isWatchMode, useExecutableRegistry)

		// In live-reload mode, validate for duplicate components on-demand
		// (In registry mode, warnings are captured once at server startup during registry creation.
		// In live-reload mode, no registry exists, so we validate on each request for the runbook.)
		if !useExecutableRegistry {
			warnings, err := validateRunbook(runbook.LocalPath)
			if err != nil {
				// Log error but don't fail the request
				slog.Warn("Failed to validate runbook for duplicates", "error", err)
			} else {
				response["warnings"] = warnings
			}
		}

		c.JSON(http.StatusOK, response)
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

// allowedAssetContentTypes maps file extensions to their MIME types.
// This is the single source of truth for both allowed-extension checks and content-type resolution.
var allowedAssetContentTypes = map[string]string{
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

// isAllowedAssetExtension checks if the file extension is in the whitelist of allowed types
func isAllowedAssetExtension(filename string) bool {
	ext := filepath.Ext(filename)
	_, ok := allowedAssetContentTypes[ext]
	return ok
}

// getContentType returns the MIME type for a file based on its extension
func getContentType(filename string) string {
	ext := filepath.Ext(filename)
	if contentType, ok := allowedAssetContentTypes[ext]; ok {
		return contentType
	}
	return "application/octet-stream"
}

// readFileContent reads a file and returns its content and file info.
func readFileContent(filePath string) ([]byte, os.FileInfo, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()

	content, err := io.ReadAll(file)
	if err != nil {
		return nil, nil, err
	}

	fileInfo, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}

	return content, fileInfo, nil
}

// handleFileError writes an appropriate JSON error response for file operations.
func handleFileError(c *gin.Context, filePath string, err error) {
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{
			"error":   "File not found",
			"details": "The file at the path " + filePath + " was not found.",
		})
	} else {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to open file",
			"details": "The file at the path " + filePath + " could not be opened.",
		})
	}
}

// buildRunbookResponse builds the JSON response map for a runbook request.
// This is a pure function (no I/O) that assembles the response fields.
func buildRunbookResponse(runbook ResolvedRunbook, content string, fileInfo os.FileInfo, isWatchMode bool, useExecutableRegistry bool) gin.H {
	response := gin.H{
		"path":                  runbook.LocalPath,
		"content":               content,
		"contentHash":           computeContentHash(content),
		"language":              getLanguageFromExtension(filepath.Base(runbook.LocalPath)),
		"size":                  fileInfo.Size(),
		"useExecutableRegistry": useExecutableRegistry,
	}

	if isWatchMode {
		response["isWatchMode"] = true
	}

	if runbook.RemoteSourceURL != "" {
		response["remoteSource"] = runbook.RemoteSourceURL
	}

	return response
}

// serveFileContent is a helper function that serves file content.
func serveFileContent(c *gin.Context, filePath string) {
	serveFileContentWithWatchMode(c, filePath, false, true, nil)
}

// serveFileContentWithWatchMode is a helper function that serves file content with optional watch mode info.
// extraFields are merged into the JSON response if non-nil (e.g., {"remoteSource": "https://..."}).
func serveFileContentWithWatchMode(c *gin.Context, filePath string, isWatchMode bool, useExecutableRegistry bool, extraFields gin.H) {
	// Open the file (handles both existence check and open in one syscall)
	file, err := os.Open(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{
				"error":   "File not found",
				"details": "The file at the path " + filePath + " was not found.",
			})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to open file",
				"details": "The file at the path " + filePath + " could not be opened.",
			})
		}
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

	// Get file info from the already-open file descriptor (avoids a second os.Stat syscall)
	fileInfo, err := file.Stat()
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

	// Merge any extra fields into the response (e.g., remote source URL)
	for k, v := range extraFields {
		response[k] = v
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
