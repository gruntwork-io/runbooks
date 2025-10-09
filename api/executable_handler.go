package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// HandleExecutablesRequest returns the registry of all executables for the runbook
func HandleExecutablesRequest(registry *ExecutableRegistry) gin.HandlerFunc {
	return func(c *gin.Context) {
		if registry == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Executable registry not initialized"})
			return
		}

		executables := registry.GetAllExecutables()
		c.JSON(http.StatusOK, executables)
	}
}


