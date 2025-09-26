package api

import (
	"io"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
)

// Return the contents of the file at the given path.
// The path is expected to be a file path, not a directory.
func HandleFileRequest(path string) gin.HandlerFunc {
	return func(c *gin.Context) {
		// The path should be a file path
		filePath := path

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
