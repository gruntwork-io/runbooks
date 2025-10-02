package api

import (
	"io"
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
func HandleRunbookRequest(runbookPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Use the runbook path directly
		filePath := runbookPath
		serveFileContent(c, filePath)
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

// serveFileContent is a helper function that serves file content
func serveFileContent(c *gin.Context, filePath string) {
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

	// Return the file contents with language and size
	c.JSON(http.StatusOK, gin.H{
		"path":     filePath,
		"content":  string(content),
		"language": getLanguageFromExtension(filepath.Base(filePath)),
		"size":     fileInfo.Size(),
	})
}
