package api

import (
	"fmt"
	"net/http"
	"strings"

	"runbooks/api/telemetry"
	"runbooks/web"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// setupCommonRoutes sets up the common routes for both server modes
func setupCommonRoutes(r *gin.Engine, runbookPath string, outputPath string, registry *ExecutableRegistry, sessionManager *SessionManager, useExecutableRegistry bool) {
	// Get embedded filesystems for serving static assets
	distFS, err := web.GetDistFS()
	if err != nil {
		panic(fmt.Sprintf("failed to get embedded dist filesystem: %v", err))
	}
	assetsFS, err := web.GetAssetsFS()
	if err != nil {
		panic(fmt.Sprintf("failed to get embedded assets filesystem: %v", err))
	}

	// Health check endpoint - used by frontend and CLI to detect if backend is running
	// Includes runbook path so CLI can verify it's talking to the correct server instance
	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "runbookPath": runbookPath})
	})

	// Telemetry configuration endpoint - returns telemetry status for frontend
	r.GET("/api/telemetry/config", func(c *gin.Context) {
		config := telemetry.GetConfig()
		c.JSON(http.StatusOK, config)
	})

	// API endpoint to serve the runbook file contents
	r.POST("/api/file", HandleFileRequest(runbookPath))

	// API endpoint to parse boilerplate.yml files
	r.POST("/api/boilerplate/variables", HandleBoilerplateRequest(runbookPath))

	// API endpoint to render boilerplate templates
	r.POST("/api/boilerplate/render", HandleBoilerplateRender(runbookPath, outputPath))

	// API endpoint to render boilerplate templates from inline template files
	r.POST("/api/boilerplate/render-inline", HandleBoilerplateRenderInline(outputPath))

	// API endpoint to get registered executables
	r.GET("/api/runbook/executables", HandleExecutablesRequest(registry))

	// Session management endpoints (single session per runbook server)
	// Public session endpoints (no auth required)
	r.POST("/api/session", HandleCreateSession(sessionManager, runbookPath))
	r.POST("/api/session/join", HandleJoinSession(sessionManager))

	// Protected session endpoints (require Bearer token)
	sessionAuth := r.Group("/api/session")
	sessionAuth.Use(SessionAuthMiddleware(sessionManager))
	{
		sessionAuth.GET("", HandleGetSession(sessionManager))
		sessionAuth.POST("/reset", HandleResetSession(sessionManager))
		sessionAuth.DELETE("", HandleDeleteSession(sessionManager))
		sessionAuth.PATCH("/env", HandleSetSessionEnv(sessionManager))
	}

	// API endpoint to execute check scripts
	r.POST("/api/exec", HandleExecRequest(registry, runbookPath, useExecutableRegistry, outputPath, sessionManager))

	// API endpoints for managing generated files
	r.GET("/api/generated-files/check", HandleGeneratedFilesCheck(outputPath))
	r.DELETE("/api/generated-files/delete", HandleGeneratedFilesDelete(outputPath))

	// AWS authentication endpoints
	r.POST("/api/aws/validate", HandleAwsValidate())
	r.GET("/api/aws/profiles", HandleAwsProfiles())
	r.POST("/api/aws/profile", HandleAwsProfileAuth())
	r.POST("/api/aws/sso/start", HandleAwsSsoStart())
	r.POST("/api/aws/sso/poll", HandleAwsSsoPoll())
	r.POST("/api/aws/sso/roles", HandleAwsSsoListRoles())
	r.POST("/api/aws/sso/complete", HandleAwsSsoComplete())
	r.POST("/api/aws/check-region", HandleAwsCheckRegion())

	// Serve runbook assets (images, PDFs, media files, etc.) from the runbook's assets directory
	r.GET("/runbook-assets/*filepath", HandleRunbookAssetsRequest(runbookPath))

	// Serve static assets (CSS, JS, etc.) from the embedded assets directory
	r.StaticFS("/assets", http.FS(assetsFS))

	// Runs when no other routes match the incoming request; useful for a single-page app
	// since we can have React handle the routing if needed.
	r.NoRoute(func(c *gin.Context) {
		// Try to serve static files from embedded dist root (e.g., images, favicon, etc.)
		path := strings.TrimPrefix(c.Request.URL.Path, "/")
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
	resolvedPath, err := ResolveRunbookPath(runbookPath)
	if err != nil {
		return fmt.Errorf("failed to resolve runbook path: %w", err)
	}

	// Create executable registry
	registry, err := NewExecutableRegistry(resolvedPath)
	if err != nil {
		return fmt.Errorf("failed to create executable registry: %w", err)
	}

	// Create session manager for persistent environment
	sessionManager := NewSessionManager()

	// Use release mode for end-users (quieter logs, better performance)
	// Use gin.New() instead of gin.Default() to skip the default logger middleware
	// This keeps the logs clean for end-users while still including recovery middleware
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// Disable proxy trusting - this is safe since we only run locally
	r.SetTrustedProxies(nil)

	// API endpoint to serve the runbook file contents
	r.GET("/api/runbook", HandleRunbookRequest(resolvedPath, false, true))

	// Set up common routes
	setupCommonRoutes(r, resolvedPath, outputPath, registry, sessionManager, true)

	// listen and serve on localhost:$port only (security: prevent remote access)
	return r.Run("127.0.0.1:" + fmt.Sprintf("%d", port))
}

// StartBackendServer starts the API server for serving runbook files
func StartBackendServer(runbookPath string, port int, outputPath string) error {
	// Resolve the runbook path to the actual file
	resolvedPath, err := ResolveRunbookPath(runbookPath)
	if err != nil {
		return fmt.Errorf("failed to resolve runbook path: %w", err)
	}

	// Create executable registry
	registry, err := NewExecutableRegistry(resolvedPath)
	if err != nil {
		return fmt.Errorf("failed to create executable registry: %w", err)
	}

	// Create session manager for persistent environment
	sessionManager := NewSessionManager()

	// Keep debug mode for development (default behavior)
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
	r.GET("/api/runbook", HandleRunbookRequest(resolvedPath, false, true))

	// Set up common routes (includes all other endpoints)
	setupCommonRoutes(r, resolvedPath, outputPath, registry, sessionManager, true)

	// listen and serve on localhost:$port only (security: prevent remote access)
	return r.Run("127.0.0.1:" + fmt.Sprintf("%d", port))
}

// StartServerWithWatch serves both the frontend files and the backend API with file watching enabled
func StartServerWithWatch(runbookPath string, port int, outputPath string, useExecutableRegistry bool) error {
	// Resolve the runbook path to the actual file
	resolvedPath, err := ResolveRunbookPath(runbookPath)
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

	// Create session manager for persistent environment
	sessionManager := NewSessionManager()

	// Create file watcher
	fileWatcher, err := NewFileWatcher(resolvedPath)
	if err != nil {
		return fmt.Errorf("failed to create file watcher: %w", err)
	}
	defer fileWatcher.Close()

	// Keep debug mode for development (default behavior)
	r := gin.Default()

	// Disable proxy trusting for local development - this is safe since we only run locally
	r.SetTrustedProxies(nil)

	// API endpoint to serve the runbook file contents
	r.GET("/api/runbook", HandleRunbookRequest(resolvedPath, true, useExecutableRegistry))

	// SSE endpoint for file change notifications
	r.GET("/api/watch", HandleWatchSSE(fileWatcher))

	// Set up common routes
	setupCommonRoutes(r, resolvedPath, outputPath, registry, sessionManager, useExecutableRegistry)

	// listen and serve on localhost:$port only (security: prevent remote access)
	return r.Run("127.0.0.1:" + fmt.Sprintf("%d", port))
}
