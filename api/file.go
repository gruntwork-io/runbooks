package api

import (
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
)

// Return the contents of the file at the given path, or if the path is a directory, return the
// contents of the runbook.md file in the directory
func HandleFileRequest(path string) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Determine the actual file path to read
		filePath := path

		// If path is a directory, look for runbook.md or runbook.mdx inside it
		if stat, err := os.Stat(path); err == nil && stat.IsDir() {
			// First try runbook.mdx, then fall back to runbook.md
			mdxPath := filepath.Join(path, "runbook.mdx")
			if _, err := os.Stat(mdxPath); err == nil {
				filePath = mdxPath
			} else {
				filePath = filepath.Join(path, "runbook.md")
			}
		}

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

		// Return the file contents
		c.JSON(http.StatusOK, gin.H{
			"path":    filePath,
			"content": string(content),
		})
	}
}
