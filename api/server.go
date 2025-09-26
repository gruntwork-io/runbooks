package api

import (
	"fmt"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// StartServer serves both the frontend files and also the backend API
func StartServer(path string, port int) {
	// TODO: Consider updating gin to run in release mode (not debug mode, except by flag)
	r := gin.Default()

	// Disable proxy trusting for local development - this is safe since we only run locally
	// TODO: Evaluate the security implications of this
	r.SetTrustedProxies(nil)

	// API endpoint to serve the runbook file contents
	r.GET("/api/file", HandleFileRequest(path))

	// API endpoint to parse boilerplate.yml files
	r.GET("/api/boilerplate/variables", HandleBoilerplateRequest(path))

	// API endpoint to render boilerplate templates
	r.POST("/api/boilerplate/render", HandleBoilerplateRender(path))

	// Serve static assets (CSS, JS, etc.) from the assets directory
	r.Static("/assets", "./web/dist/assets")

	// Runs when no other routes match the incoming request; useful for a single-page app
	// since we can have React handle the routing if needed.
	r.NoRoute(func(c *gin.Context) {
		// Serve static files for any path that doesn't match /api/file
		c.File("./web/dist/index.html")
	})

	// listen and serve on 0.0.0.0:$port | localhost:$port
	r.Run(":" + fmt.Sprintf("%d", port))
}

// StartBackendServer starts the API server for serving runbook files
func StartBackendServer(path string, port int) {
	// TODO: Consider updating gin to run in release mode (not debug mode, except by flag)
	r := gin.Default()

	// Disable proxy trusting for local development - this is safe since we only run locally
	r.SetTrustedProxies(nil)

	// Configure CORS to allow requests from the frontend on various ports
	r.Use(cors.New(cors.Config{
		// Cursor likes to run its own servers when cursoring, so let it do so without hitting CORS
		AllowOrigins:     []string{"http://localhost:5173", "http://localhost:5174", "http://localhost:5175"},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	}))

	// API endpoint to serve the runbook file contents
	r.GET("/api/file", HandleFileRequest(path))

	// API endpoint to parse boilerplate.yml files
	r.GET("/api/boilerplate/variables", HandleBoilerplateRequest(path))

	// API endpoint to render boilerplate templates
	r.POST("/api/boilerplate/render", HandleBoilerplateRender(path))

	// listen and serve on 0.0.0.0:$port | localhost:$port
	r.Run(":" + fmt.Sprintf("%d", port))
}
