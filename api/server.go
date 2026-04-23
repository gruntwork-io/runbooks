package api

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/gruntwork-io/runbooks/adapters"
	"github.com/gruntwork-io/runbooks/api/telemetry"
	"github.com/gruntwork-io/runbooks/core/ports"
	"github.com/gruntwork-io/runbooks/web"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// setupCommonRoutes sets up the common routes for both server modes
func setupCommonRoutes(r *gin.Engine, gruntbookPath string, workingDir string, outputPath string, registry *ExecutableRegistry, sessionManager *SessionManager, tokens *TokenResolver, aws ports.AwsClient, gh ports.GitHubClient, useExecutableRegistry bool) {
	// If the gruntbook contains AwsAuth blocks, strip AWS credentials from session
	// at creation time. This ensures users must explicitly confirm which AWS account
	// they want to use before any scripts can access the credentials.
	//
	// Always overwrite (with nil when there's no AwsAuth) instead of only setting
	// when non-empty, so a SessionManager reused across gruntbooks — e.g. a host
	// injecting one via ServerConfig.Sessions, or a future serve mode that swaps
	// registries without rebuilding the manager — doesn't inherit a prior
	// gruntbook's protection list.
	var protected []string
	if registry != nil && registry.HasComponent("AwsAuth") {
		protected = []string{
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_SESSION_TOKEN",
		}
	}
	sessionManager.SetProtectedEnvVars(protected)

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
	// Includes gruntbook path so CLI can verify it's talking to the correct server instance
	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "gruntbookPath": gruntbookPath})
	})

	// Telemetry configuration endpoint - returns telemetry status for frontend
	r.GET("/api/telemetry/config", func(c *gin.Context) {
		config := telemetry.GetConfig()
		c.JSON(http.StatusOK, config)
	})

	// API endpoint to serve the gruntbook file contents
	r.POST("/api/file", HandleFileRequest(gruntbookPath))

	// API endpoint to parse boilerplate.yml files
	r.POST("/api/boilerplate/variables", HandleBoilerplateRequest(gruntbookPath))

	// API endpoint to render boilerplate templates
	r.POST("/api/boilerplate/render", HandleBoilerplateRender(gruntbookPath, workingDir, outputPath, sessionManager))

	// API endpoint to render boilerplate templates from inline template files
	r.POST("/api/boilerplate/render-inline", HandleBoilerplateRenderInline(workingDir, outputPath, sessionManager))

	// API endpoint to get registered executables
	r.GET("/api/gruntbook/executables", HandleExecutablesRequest(registry))

	// Session management endpoints
	//
	// Security model:
	// - Localhost binding (127.0.0.1) protects against remote attackers
	// - Bearer token protects sensitive endpoints (exec, session ops) against:
	//   1. CSRF attacks from malicious websites (browsers don't auto-send bearer tokens)
	//   2. Other local processes that don't have the token
	// - Unauthenticated endpoints are lower-risk (read-only info, no command execution)
	//
	// These endpoints must be unauthenticated (chicken-and-egg: need to get a token first)
	r.POST("/api/session", HandleCreateSession(sessionManager, workingDir))
	r.POST("/api/session/join", HandleJoinSession(sessionManager))

	// Session-scoped endpoints (require Bearer token for session context + CSRF protection)
	sessionAuth := r.Group("/api/session")
	sessionAuth.Use(SessionAuthMiddleware(sessionManager))
	{
		sessionAuth.GET("", HandleGetSession(sessionManager))
		sessionAuth.POST("/reset", HandleResetSession(sessionManager))
		sessionAuth.DELETE("", HandleDeleteSession(sessionManager))
		sessionAuth.PATCH("/env", HandleSetSessionEnv(sessionManager))
	}

	// Execution endpoint (token required: runs arbitrary commands, high-risk without auth)
	protectedAPI := r.Group("/api")
	protectedAPI.Use(SessionAuthMiddleware(sessionManager))
	{
		protectedAPI.POST("/exec", HandleExecRequest(registry, gruntbookPath, useExecutableRegistry, workingDir, outputPath, sessionManager))
		// Environment credential detection (read-only, does not register to session)
		protectedAPI.GET("/aws/env-credentials", HandleAwsEnvCredentials())
		// Confirm and register detected credentials to session (after user confirmation)
		protectedAPI.POST("/aws/env-credentials/confirm", HandleAwsConfirmEnvCredentials(sessionManager))
		// AWS auth endpoints that return credentials (token required: returns secrets)
		protectedAPI.POST("/aws/profile", HandleAwsProfileAuth())
		protectedAPI.POST("/aws/sso/poll", HandleAwsSsoPoll())
		protectedAPI.POST("/aws/sso/complete", HandleAwsSsoComplete())
		// GitHub auth endpoints that return credentials (token required: returns secrets)
		protectedAPI.POST("/github/oauth/poll", HandleGitHubOAuthPoll())
		protectedAPI.POST("/github/env-credentials", HandleGitHubEnvCredentials(sessionManager))
		protectedAPI.POST("/github/cli-credentials", HandleGitHubCliCredentials(sessionManager))
		// GitHub browsing endpoints for GitClone block (read-only, requires session for token)
		protectedAPI.GET("/github/orgs", HandleGitHubListOrgs(sessionManager))
		protectedAPI.GET("/github/repos", HandleGitHubListRepos(sessionManager))
		protectedAPI.GET("/github/refs", HandleGitHubListRefs(sessionManager))
		// Git clone endpoint (SSE streaming)
		protectedAPI.POST("/git/clone", HandleGitClone(sessionManager, workingDir, tokens))
		// GitHub pull request endpoints
		protectedAPI.GET("/github/labels", HandleGitHubListLabels(sessionManager))
		protectedAPI.POST("/git/pull-request", HandleGitPullRequest(sessionManager))
		protectedAPI.POST("/git/push", HandleGitPush(sessionManager))
		protectedAPI.DELETE("/git/branch", HandleGitDeleteBranch())
		// OpenTofu module parsing (reads local files and may clone remote repos with user tokens)
		protectedAPI.POST("/tf/parse", HandleTfModuleParse(gruntbookPath, tokens))
		// Workspace endpoints for file tree, file content, and git changes
		protectedAPI.GET("/workspace/tree", HandleWorkspaceTree())
		protectedAPI.GET("/workspace/dirs", HandleWorkspaceDirs())
		protectedAPI.GET("/workspace/file", HandleWorkspaceFile())
		protectedAPI.GET("/workspace/changes", HandleWorkspaceChanges())
		protectedAPI.POST("/workspace/register", HandleWorkspaceRegister(sessionManager))
		protectedAPI.POST("/workspace/set-active", HandleWorkspaceSetActive(sessionManager))
	}

	// Generated files endpoints (no session context needed)
	r.GET("/api/generated-files/check", HandleGeneratedFilesCheck(workingDir, outputPath))
	r.DELETE("/api/generated-files/delete", HandleGeneratedFilesDelete(workingDir, outputPath))

	// AWS authentication endpoints (no credentials returned)
	// No token required: these endpoints don't return secrets, and allowing them
	// unauthenticated lets the AWS auth UI render before session is created.
	r.POST("/api/aws/validate", HandleAwsValidate(aws))
	r.GET("/api/aws/profiles", HandleAwsProfiles())           // Only returns profile names and auth types
	r.POST("/api/aws/sso/start", HandleAwsSsoStart())         // Returns device code for user to authorize
	r.POST("/api/aws/sso/roles", HandleAwsSsoListRoles())     // Returns role names, not credentials
	r.POST("/api/aws/check-region", HandleAwsCheckRegion())

	// GitHub authentication endpoints (no credentials returned)
	// No token required: these endpoints don't return secrets
	r.POST("/api/github/validate", HandleGitHubValidate(gh))   // Validates token, returns user info
	r.POST("/api/github/oauth/start", HandleGitHubOAuthStart()) // Device flow: returns device code

	// Serve gruntbook assets (images, PDFs, media files, etc.) from the gruntbook's assets directory
	r.GET("/gruntbook-assets/*filepath", HandleGruntbookAssetsRequest(gruntbookPath))

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

// ServerConfig holds all configuration for starting the API server.
type ServerConfig struct {
	GruntbookPath         string
	Port                  int
	WorkingDir            string
	OutputPath            string
	RemoteSourceURL       string
	UseExecutableRegistry bool // When true, scripts are validated against a registry built at startup
	IsWatchMode           bool // When true, enables file watching with SSE notifications
	ReleaseMode           bool // When true, uses gin release mode (quieter logs for end-users)
	EnableCORS            bool // When true, allows cross-origin requests (for dev with separate frontend)
	// Sessions is the shared SessionManager. When non-nil, Gin uses it
	// instead of creating its own — this is how M4's IPC services and
	// the legacy Gin handlers see the same session state (env, active
	// worktree, execution count). Leave nil for standalone CLI uses
	// (gruntbooks serve on older builds, tests); buildHandler creates
	// a private one in that case.
	Sessions *SessionManager

	// Registry is the shared ExecutableRegistry built from the open
	// gruntbook. When non-nil, Gin uses it instead of parsing the
	// gruntbook again — M4's IPC ExecService needs the same registry
	// Gin is already serving so script lookups match byte-for-byte.
	// Only populated when UseExecutableRegistry is true.
	Registry *ExecutableRegistry
}

// StartServer starts the API server and blocks until it exits.
func StartServer(cfg ServerConfig) error {
	handler, cleanup, err := buildHandler(cfg)
	if err != nil {
		return err
	}
	if cleanup != nil {
		defer cleanup()
	}
	return http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", cfg.Port), handler)
}

// ServerHandle bundles the runtime handles returned by
// StartServerWithShutdown: the bound port, a graceful-shutdown
// function, and a channel that fires once the server exits.
type ServerHandle struct {
	// Port is the TCP port the listener is bound to. When
	// ServerConfig.Port is 0, the kernel picks a free port and this
	// field reports which one.
	Port int
	// Shutdown gracefully stops the server. The context bounds how long
	// to wait for in-flight requests to drain before forcing close.
	Shutdown func(context.Context) error
	// ErrCh fires exactly once when the server exits: nil on a clean
	// Shutdown, or the underlying error otherwise.
	ErrCh <-chan error
}

// StartServerWithShutdown binds the listener synchronously and then
// serves in a background goroutine. Binding first (instead of
// http.ListenAndServe) closes the startup race window where a caller
// could fire a request before the kernel is queuing connections — by
// the time this function returns, the listener is already accepting.
//
// Used by the desktop path where the user can close a gruntbook and
// return to the Welcome screen without quitting the app.
func StartServerWithShutdown(cfg ServerConfig) (*ServerHandle, error) {
	handler, cleanup, err := buildHandler(cfg)
	if err != nil {
		return nil, err
	}

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		if cleanup != nil {
			cleanup()
		}
		return nil, fmt.Errorf("bind listener on %s: %w", addr, err)
	}
	port := listener.Addr().(*net.TCPAddr).Port

	srv := &http.Server{Handler: handler}

	ch := make(chan error, 1)
	go func() {
		serveErr := srv.Serve(listener)
		if cleanup != nil {
			cleanup()
		}
		if errors.Is(serveErr, http.ErrServerClosed) {
			ch <- nil
		} else {
			ch <- serveErr
		}
	}()

	return &ServerHandle{
		Port:     port,
		Shutdown: srv.Shutdown,
		ErrCh:    ch,
	}, nil
}

// buildHandler wires up the Gin engine and any resources it owns
// (currently just the file watcher in watch mode). The returned cleanup
// function must be invoked once serving stops.
func buildHandler(cfg ServerConfig) (http.Handler, func(), error) {
	resolvedPath, err := ResolveGruntbookPath(cfg.GruntbookPath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to resolve gruntbook path: %w", err)
	}

	registry := cfg.Registry
	if registry == nil && cfg.UseExecutableRegistry {
		registry, err = NewExecutableRegistry(resolvedPath)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to create executable registry: %w", err)
		}
	}

	sessionManager := cfg.Sessions
	if sessionManager == nil {
		sessionManager = NewSessionManager()
	}

	// Host-backed adapters for the ports consumed by handlers built in
	// setupCommonRoutes. A hosted build would swap in tenant-scoped
	// adapters here without changing anything downstream.
	tokens := NewTokenResolver(adapters.NewOsEnvironment(), adapters.NewOsProcessSpawner())
	awsClient := adapters.NewSdkAwsClient()
	ghClient := adapters.NewHttpGitHubClient()

	r := newGinEngine(cfg.ReleaseMode)
	r.SetTrustedProxies(nil)

	if cfg.EnableCORS {
		r.Use(cors.New(cors.Config{
			AllowOrigins:     []string{"http://localhost:5173", "http://localhost:5174", "http://localhost:5175"},
			AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
			AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
			ExposeHeaders:    []string{"Content-Length"},
			AllowCredentials: true,
		}))
	}

	r.GET("/api/gruntbook", HandleGruntbookRequest(GruntbookConfig{
		LocalPath:             resolvedPath,
		IsWatchMode:           cfg.IsWatchMode,
		UseExecutableRegistry: cfg.UseExecutableRegistry,
		RemoteSourceURL:       cfg.RemoteSourceURL,
	}))

	var cleanup func()
	if cfg.IsWatchMode {
		fileWatcher, err := NewFileWatcher(resolvedPath)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to create file watcher: %w", err)
		}
		cleanup = func() { fileWatcher.Close() }
		r.GET("/api/watch", HandleWatchSSE(fileWatcher))
	}

	setupCommonRoutes(r, resolvedPath, cfg.WorkingDir, cfg.OutputPath, registry, sessionManager, tokens, awsClient, ghClient, cfg.UseExecutableRegistry)

	return r, cleanup, nil
}

// newGinEngine creates a gin engine with the appropriate mode.
// Release mode uses minimal logging for end-users; debug mode includes request logging.
func newGinEngine(releaseMode bool) *gin.Engine {
	if releaseMode {
		gin.SetMode(gin.ReleaseMode)
		r := gin.New()
		r.Use(gin.Recovery())
		return r
	}
	return gin.Default()
}
