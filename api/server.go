package api

import (
	"fmt"
	"net/http"

	"runbooks/web"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// setupCommonRoutes sets up the common routes for both server modes
func setupCommonRoutes(r *gin.Engine, runbookPath string, outputPath string, registry *ExecutableRegistry, useExecutableRegistry bool) {
	// Get embedded filesystems for serving static assets
	distFS, err := web.GetDistFS()
	if err != nil {
		panic(fmt.Sprintf("failed to get embedded dist filesystem: %v", err))
	}
	assetsFS, err := web.GetAssetsFS()
	if err != nil {
		panic(fmt.Sprintf("failed to get embedded assets filesystem: %v", err))
	}

	// API endpoint to serve the runbook file contents
	r.POST("/api/file", HandleFileRequest(runbookPath))

	// API endpoint to parse boilerplate.yml files
	r.POST("/api/boilerplate/variables", HandleBoilerplateRequest(runbookPath))

	// API endpoint to render boilerplate templates
	r.POST("/api/boilerplate/render", HandleBoilerplateRender(runbookPath, outputPath))

	// API endpoint to render boilerplate templates from inline template files
	r.POST("/api/boilerplate/render-inline", HandleBoilerplateRenderInline())

	// API endpoint to get registered executables
	r.GET("/api/runbook/executables", HandleExecutablesRequest(registry))

	// API endpoint to execute check scripts
	r.POST("/api/exec", HandleExecRequest(registry, runbookPath, useExecutableRegistry))

	// API endpoints for managing generated files
	r.GET("/api/generated-files/check", HandleGeneratedFilesCheck(outputPath))
	r.DELETE("/api/generated-files/delete", HandleGeneratedFilesDelete(outputPath))

	// Serve runbook assets (images, PDFs, media files, etc.) from the runbook's assets directory
	r.GET("/runbook-assets/*filepath", HandleRunbookAssetsRequest(runbookPath))

	// Serve static assets (CSS, JS, etc.) from the embedded assets directory
	r.StaticFS("/assets", http.FS(assetsFS))

	// Runs when no other routes match the incoming request; useful for a single-page app
	// since we can have React handle the routing if needed.
	r.NoRoute(func(c *gin.Context) {
		// Try to serve static files from embedded dist root (e.g., images, favicon, etc.)
		path := c.Request.URL.Path
		if path[0] == '/' {
			path = path[1:] // Remove leading slash for fs.Open
		}
		if file, err := distFS.Open(path); err == nil {
			defer file.Close()
			if stat, err := file.Stat(); err == nil && !stat.IsDir() {
				http.ServeFileFS(c.Writer, c.Request, distFS, path)
				return
			}
		}
		// Fall back to serving index.html for SPA routing
		http.ServeFileFS(c.Writer, c.Request, distFS, "index.html")
	})
}

// StartServer serves both the frontend files and also the backend API
func StartServer(runbookPath string, port int, outputPath string) error {
	// Resolve the runbook path to the actual file
	resolvedPath, err := resolveRunbookPath(runbookPath)
	if err != nil {
		return fmt.Errorf("failed to resolve runbook path: %w", err)
	}

	// Create executable registry
	registry, err := NewExecutableRegistry(resolvedPath)
	if err != nil {
		return fmt.Errorf("failed to create executable registry: %w", err)
	}

	// TODO: Consider updating gin to run in release mode (not debug mode, except by flag)
	r := gin.Default()

	// Disable proxy trusting for local development - this is safe since we only run locally
	// TODO: If runbooks is ever deployed behind a proxy (nginx, load balancer, etc.), 
	//       we'll need to configure trusted proxies to get accurate client IPs
	r.SetTrustedProxies(nil)

	// API endpoint to serve the runbook file contents
	r.GET("/api/runbook", HandleRunbookRequest(runbookPath, false, true))

	// Set up common routes
	setupCommonRoutes(r, runbookPath, outputPath, registry, true)

	// listen and serve on localhost:$port only (security: prevent remote access)
	return r.Run("127.0.0.1:" + fmt.Sprintf("%d", port))
}

// StartBackendServer starts the API server for serving runbook files
func StartBackendServer(runbookPath string, port int, outputPath string) error {
	// Resolve the runbook path to the actual file
	resolvedPath, err := resolveRunbookPath(runbookPath)
	if err != nil {
		return fmt.Errorf("failed to resolve runbook path: %w", err)
	}

	// Create executable registry
	registry, err := NewExecutableRegistry(resolvedPath)
	if err != nil {
		return fmt.Errorf("failed to create executable registry: %w", err)
	}

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
	r.GET("/api/runbook", HandleRunbookRequest(runbookPath, false, true))

	// Set up common routes (includes all other endpoints)
	setupCommonRoutes(r, runbookPath, outputPath, registry, true)

	// listen and serve on localhost:$port only (security: prevent remote access)
	return r.Run("127.0.0.1:" + fmt.Sprintf("%d", port))
}

// StartServerWithWatch serves both the frontend files and the backend API with file watching enabled
func StartServerWithWatch(runbookPath string, port int, outputPath string, useExecutableRegistry bool) error {
	// Resolve the runbook path to the actual file
	resolvedPath, err := resolveRunbookPath(runbookPath)
	if err != nil {
		return fmt.Errorf("failed to resolve runbook path: %w", err)
	}

	var registry *ExecutableRegistry
	if useExecutableRegistry {
		// Create executable registry
		registry, err = NewExecutableRegistry(resolvedPath)
		if err != nil {
			return fmt.Errorf("failed to create executable registry: %w", err)
		}
	}

	// Create file watcher
	fileWatcher, err := NewFileWatcher(resolvedPath)
	if err != nil {
		return fmt.Errorf("failed to create file watcher: %w", err)
	}
	defer fileWatcher.Close()

	// TODO: Consider updating gin to run in release mode (not debug mode, except by flag)
	r := gin.Default()

	// Disable proxy trusting for local development - this is safe since we only run locally
	// TODO: If runbooks is ever deployed behind a proxy (nginx, load balancer, etc.), 
	//       we'll need to configure trusted proxies to get accurate client IPs
	r.SetTrustedProxies(nil)

	// API endpoint to serve the runbook file contents
	r.GET("/api/runbook", HandleRunbookRequest(runbookPath, true, useExecutableRegistry))

	// SSE endpoint for file change notifications
	r.GET("/api/watch", HandleWatchSSE(fileWatcher))

	// Set up common routes
	setupCommonRoutes(r, runbookPath, outputPath, registry, useExecutableRegistry)

	// listen and serve on localhost:$port only (security: prevent remote access)
	return r.Run("127.0.0.1:" + fmt.Sprintf("%d", port))
}
