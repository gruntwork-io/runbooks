package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// HandleExecutablesRequest returns the registry of all executables and warnings for the runbook
// In live-file-reload mode, registry will be nil, and this returns an empty registry
func HandleExecutablesRequest(registry *ExecutableRegistry) gin.HandlerFunc {
	return func(c *gin.Context) {
		if registry == nil {
			// Live-file-reload mode: no registry exists
			c.JSON(http.StatusOK, gin.H{
				"executables": make(map[string]Executable),
				"warnings":    []string{},
			})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"executables": registry.GetAllExecutables(),
			"warnings":    registry.GetWarnings(),
		})
	}
}


