package api

import (
	"fmt"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// StartServer starts the API server for serving runbook files
func StartServer(path string, port int) {
	// TODO: Consider updating gin to run in release mode (not debug mode, except by flag)
	r := gin.Default()

	// Disable proxy trusting for local development - this is safe since we only run locally
	r.SetTrustedProxies(nil)

	// Configure CORS to allow requests from the frontend on port 5173 to a different port
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"http://localhost:5173"},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	}))

	// API endpoint to serve the runbook file contents
	r.GET("/api/file", HandleFileRequest(path))

	// listen and serve on 0.0.0.0:$port | localhost:$port
	r.Run(":" + fmt.Sprintf("%d", port))
}
