/**
 * @fileoverview Mock Data for Files Workspace
 * 
 * Provides realistic mock data for demonstrating the workspace UI.
 * This will be replaced with actual API data in the future.
 */

import type { WorkspaceState, WorkspaceTreeNode } from '@/types/workspace'
import type { WorkspaceFileChange } from '@/hooks/useWorkspaceChanges'

/**
 * Generate mock workspace data
 */
export function getMockWorkspaceData(): WorkspaceState {
  return {
    gitInfo: {
      repoUrl: 'github.com/gruntwork-io/terraform-aws-lambda',
      repoName: 'terraform-aws-lambda',
      repoOwner: 'gruntwork-io',
      branch: 'main',
      commitSha: 'a1b2c3d4e5f6789012345678901234567890abcd',
    },
    localPath: '~/.runbooks/repos/gruntwork-io/terraform-aws-lambda',
    files: getMockFileTree(),
    changes: getMockChanges(),
    stats: {
      totalFiles: 32,
      generatedFiles: 0, // Will be updated by the component
      changedFiles: 4,
      totalAdditions: 42,
      totalDeletions: 14,
    },
    isLoading: false,
  }
}

/**
 * Generate mock file tree with diverse file types to showcase icons
 */
function getMockFileTree(): WorkspaceTreeNode[] {
  return [
    {
      id: 'root-infra',
      name: 'infra',
      type: 'folder',
      children: [
        {
          id: 'infra-live',
          name: 'live',
          type: 'folder',
          children: [
            {
              id: 'live-terragrunt',
              name: 'terragrunt.hcl',
              type: 'file',
              file: { id: 'live-terragrunt', name: 'terragrunt.hcl', path: 'infra/live/terragrunt.hcl', language: 'hcl', content: '# Root terragrunt config' },
            },
            {
              id: 'live-prod',
              name: 'prod',
              type: 'folder',
              children: [
                {
                  id: 'prod-terragrunt',
                  name: 'terragrunt.hcl',
                  type: 'file',
                  file: { id: 'prod-terragrunt', name: 'terragrunt.hcl', path: 'infra/live/prod/terragrunt.hcl', language: 'hcl', content: '# Prod terragrunt' },
                },
                {
                  id: 'prod-main',
                  name: 'main.tf',
                  type: 'file',
                  file: { id: 'prod-main', name: 'main.tf', path: 'infra/live/prod/main.tf', language: 'hcl', content: '# Prod main' },
                },
                {
                  id: 'prod-vars',
                  name: 'terraform.tfvars',
                  type: 'file',
                  file: { id: 'prod-vars', name: 'terraform.tfvars', path: 'infra/live/prod/terraform.tfvars', language: 'hcl', content: '# Prod vars' },
                },
              ],
            },
          ],
        },
        {
          id: 'infra-modules',
          name: 'modules',
          type: 'folder',
          children: [
            {
              id: 'modules-lambda',
              name: 'lambda',
              type: 'folder',
              children: [
                { id: 'lambda-main', name: 'main.tf', type: 'file', file: { id: 'lambda-main', name: 'main.tf', path: 'infra/modules/lambda/main.tf', language: 'hcl', content: '# Lambda module' } },
                { id: 'lambda-vars', name: 'variables.tf', type: 'file', file: { id: 'lambda-vars', name: 'variables.tf', path: 'infra/modules/lambda/variables.tf', language: 'hcl', content: '# Variables' } },
                { id: 'lambda-outputs', name: 'outputs.tf', type: 'file', file: { id: 'lambda-outputs', name: 'outputs.tf', path: 'infra/modules/lambda/outputs.tf', language: 'hcl', content: '# Outputs' } },
                { id: 'lambda-long', name: 'this-is-a-very-long-filename-that-should-overflow-horizontally.tf', type: 'file', file: { id: 'lambda-long', name: 'this-is-a-very-long-filename-that-should-overflow-horizontally.tf', path: 'infra/modules/lambda/this-is-a-very-long-filename-that-should-overflow-horizontally.tf', language: 'hcl', content: '# Long filename test' } },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'root-src',
      name: 'src',
      type: 'folder',
      children: [
        {
          id: 'src-api',
          name: 'api',
          type: 'folder',
          children: [
            { id: 'api-main', name: 'main.go', type: 'file', file: { id: 'api-main', name: 'main.go', path: 'src/api/main.go', language: 'go', content: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Config holds application configuration
type Config struct {
	Port            int           \`json:"port"\`
	ReadTimeout     time.Duration \`json:"read_timeout"\`
	WriteTimeout    time.Duration \`json:"write_timeout"\`
	ShutdownTimeout time.Duration \`json:"shutdown_timeout"\`
	LogLevel        string        \`json:"log_level"\`
}

// Server wraps the HTTP server with graceful shutdown
type Server struct {
	config     *Config
	httpServer *http.Server
	router     *http.ServeMux
	logger     *log.Logger
	wg         sync.WaitGroup
}

// User represents a user in the system
type User struct {
	ID        string    \`json:"id"\`
	Email     string    \`json:"email"\`
	Name      string    \`json:"name"\`
	CreatedAt time.Time \`json:"created_at"\`
	UpdatedAt time.Time \`json:"updated_at"\`
}

// Response is a generic API response wrapper
type Response struct {
	Success bool        \`json:"success"\`
	Data    interface{} \`json:"data,omitempty"\`
	Error   string      \`json:"error,omitempty"\`
}

// NewServer creates a new server instance
func NewServer(cfg *Config) *Server {
	logger := log.New(os.Stdout, "[API] ", log.LstdFlags|log.Lshortfile)
	router := http.NewServeMux()

	s := &Server{
		config: cfg,
		router: router,
		logger: logger,
	}

	s.registerRoutes()

	s.httpServer = &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      s.loggingMiddleware(router),
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
	}

	return s
}

// registerRoutes sets up all API routes
func (s *Server) registerRoutes() {
	s.router.HandleFunc("/health", s.handleHealth)
	s.router.HandleFunc("/api/v1/users", s.handleUsers)
	s.router.HandleFunc("/api/v1/users/", s.handleUserByID)
	s.router.HandleFunc("/api/v1/status", s.handleStatus)
}

// loggingMiddleware logs all incoming requests
func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		s.logger.Printf("Started %s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
		s.logger.Printf("Completed %s %s in %v", r.Method, r.URL.Path, time.Since(start))
	})
}

// handleHealth returns server health status
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	s.writeJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"status":    "healthy",
			"timestamp": time.Now().UTC(),
		},
	})
}

// handleStatus returns detailed server status
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	s.writeJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"version":   "1.0.0",
			"uptime":    time.Now().Unix(),
			"goroutines": 42,
		},
	})
}

// handleUsers handles user collection operations
func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.listUsers(w, r)
	case http.MethodPost:
		s.createUser(w, r)
	default:
		s.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleUserByID handles single user operations
func (s *Server) handleUserByID(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getUser(w, r)
	case http.MethodPut:
		s.updateUser(w, r)
	case http.MethodDelete:
		s.deleteUser(w, r)
	default:
		s.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// listUsers returns all users
func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	users := []User{
		{ID: "1", Email: "alice@example.com", Name: "Alice", CreatedAt: time.Now()},
		{ID: "2", Email: "bob@example.com", Name: "Bob", CreatedAt: time.Now()},
	}
	s.writeJSON(w, http.StatusOK, Response{Success: true, Data: users})
}

// createUser creates a new user
func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var user User
	if err := json.NewDecoder(r.Body).Decode(&user); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user.ID = fmt.Sprintf("%d", time.Now().UnixNano())
	user.CreatedAt = time.Now()
	s.writeJSON(w, http.StatusCreated, Response{Success: true, Data: user})
}

// getUser returns a single user by ID
func (s *Server) getUser(w http.ResponseWriter, r *http.Request) {
	user := User{ID: "1", Email: "alice@example.com", Name: "Alice"}
	s.writeJSON(w, http.StatusOK, Response{Success: true, Data: user})
}

// updateUser updates an existing user
func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	var user User
	if err := json.NewDecoder(r.Body).Decode(&user); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user.UpdatedAt = time.Now()
	s.writeJSON(w, http.StatusOK, Response{Success: true, Data: user})
}

// deleteUser deletes a user
func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, Response{Success: true})
}

// writeJSON writes a JSON response
func (s *Server) writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// writeError writes an error response
func (s *Server) writeError(w http.ResponseWriter, status int, message string) {
	s.writeJSON(w, status, Response{Success: false, Error: message})
}

// Start begins listening for requests
func (s *Server) Start() error {
	s.logger.Printf("Server starting on port %d", s.config.Port)
	return s.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the server
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Println("Server shutting down...")
	return s.httpServer.Shutdown(ctx)
}

func main() {
	cfg := &Config{
		Port:            8080,
		ReadTimeout:     15 * time.Second,
		WriteTimeout:    15 * time.Second,
		ShutdownTimeout: 30 * time.Second,
		LogLevel:        "info",
	}

	server := NewServer(cfg)

	// Start server in goroutine
	go func() {
		if err := server.Start(); err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	// Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Shutdown error: %v", err)
	}

	log.Println("Server stopped")
}` } },
            { id: 'api-handler', name: 'handler.go', type: 'file', file: { id: 'api-handler', name: 'handler.go', path: 'src/api/handler.go', language: 'go', content: '// Handler' } },
            { id: 'api-test', name: 'main_test.go', type: 'file', file: { id: 'api-test', name: 'main_test.go', path: 'src/api/main_test.go', language: 'go', content: '// Tests' } },
          ],
        },
        {
          id: 'src-web',
          name: 'web',
          type: 'folder',
          children: [
            { id: 'web-app', name: 'App.tsx', type: 'file', file: { id: 'web-app', name: 'App.tsx', path: 'src/web/App.tsx', language: 'typescript', content: '// React App' } },
            { id: 'web-index', name: 'index.ts', type: 'file', file: { id: 'web-index', name: 'index.ts', path: 'src/web/index.ts', language: 'typescript', content: '// Entry' } },
            { id: 'web-utils', name: 'utils.js', type: 'file', file: { id: 'web-utils', name: 'utils.js', path: 'src/web/utils.js', language: 'javascript', content: '// Utils' } },
            { id: 'web-styles', name: 'styles.css', type: 'file', file: { id: 'web-styles', name: 'styles.css', path: 'src/web/styles.css', language: 'css', content: '/* Styles */' } },
            { id: 'web-index-html', name: 'index.html', type: 'file', file: { id: 'web-index-html', name: 'index.html', path: 'src/web/index.html', language: 'html', content: '<!-- HTML -->' } },
          ],
        },
        {
          id: 'src-scripts',
          name: 'scripts',
          type: 'folder',
          children: [
            { id: 'scripts-deploy', name: 'deploy.sh', type: 'file', file: { id: 'scripts-deploy', name: 'deploy.sh', path: 'src/scripts/deploy.sh', language: 'shell', content: '#!/bin/bash' } },
            { id: 'scripts-setup', name: 'setup.py', type: 'file', file: { id: 'scripts-setup', name: 'setup.py', path: 'src/scripts/setup.py', language: 'python', content: '# Python' } },
            { id: 'scripts-build', name: 'build.ps1', type: 'file', file: { id: 'scripts-build', name: 'build.ps1', path: 'src/scripts/build.ps1', language: 'powershell', content: '# PowerShell' } },
          ],
        },
      ],
    },
    {
      id: 'root-config',
      name: 'config',
      type: 'folder',
      children: [
        { id: 'config-json', name: 'config.json', type: 'file', file: { id: 'config-json', name: 'config.json', path: 'config/config.json', language: 'json', content: '{}' } },
        { id: 'config-yaml', name: 'settings.yaml', type: 'file', file: { id: 'config-yaml', name: 'settings.yaml', path: 'config/settings.yaml', language: 'yaml', content: '# YAML' } },
        { id: 'config-toml', name: 'app.toml', type: 'file', file: { id: 'config-toml', name: 'app.toml', path: 'config/app.toml', language: 'toml', content: '# TOML' } },
      ],
    },
    {
      id: 'root-assets',
      name: 'assets',
      type: 'folder',
      children: [
        { id: 'assets-logo', name: 'logo.png', type: 'file', file: { id: 'assets-logo', name: 'logo.png', path: 'assets/logo.png', language: 'binary', content: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTAwIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjMTBiOTgxIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IndoaXRlIiBmb250LXNpemU9IjI0IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiI+TG9nbzwvdGV4dD48L3N2Zz4=' } },
        { id: 'assets-hero', name: 'hero.jpg', type: 'file', file: { id: 'assets-hero', name: 'hero.jpg', path: 'assets/hero.jpg', language: 'binary', content: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MDAiIGhlaWdodD0iNDAwIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjNjM2NmYxIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IndoaXRlIiBmb250LXNpemU9IjQ4IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiI+SGVybyBJbWFnZTwvdGV4dD48L3N2Zz4=' } },
        { id: 'assets-icon', name: 'icon.svg', type: 'file', file: { id: 'assets-icon', name: 'icon.svg', path: 'assets/icon.svg', language: 'svg', content: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI0MCIgZmlsbD0iIzRGNDZFNSIvPjx0ZXh0IHg9IjUwIiB5PSI1NSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0id2hpdGUiIGZvbnQtc2l6ZT0iMjAiPkljb248L3RleHQ+PC9zdmc+' } },
        { id: 'assets-bundle', name: 'bundle.zip', type: 'file', file: { id: 'assets-bundle', name: 'bundle.zip', path: 'assets/bundle.zip', language: 'binary', content: '' } },
      ],
    },
    { id: 'root-readme', name: 'README.md', type: 'file', file: { id: 'root-readme', name: 'README.md', path: 'README.md', language: 'markdown', content: '# Project' } },
    { id: 'root-dockerfile', name: 'Dockerfile', type: 'file', file: { id: 'root-dockerfile', name: 'Dockerfile', path: 'Dockerfile', language: 'dockerfile', content: 'FROM node:18' } },
    { id: 'root-env', name: '.env.example', type: 'file', file: { id: 'root-env', name: '.env.example', path: '.env.example', language: 'env', content: '# Environment' } },
    { id: 'root-package', name: 'package.json', type: 'file', file: { id: 'root-package', name: 'package.json', path: 'package.json', language: 'json', content: '{}' } },
    { id: 'root-lock', name: 'package-lock.json', type: 'file', file: { id: 'root-lock', name: 'package-lock.json', path: 'package-lock.json', language: 'json', content: '{}' } },
    { id: 'root-gomod', name: 'go.mod', type: 'file', file: { id: 'root-gomod', name: 'go.mod', path: 'go.mod', language: 'go', content: 'module example' } },
    { id: 'root-license', name: 'LICENSE', type: 'file', file: { id: 'root-license', name: 'LICENSE', path: 'LICENSE', language: 'text', content: 'MIT License' } },
    { id: 'root-taskfile', name: 'Taskfile.yml', type: 'file', file: { id: 'root-taskfile', name: 'Taskfile.yml', path: 'Taskfile.yml', language: 'yaml', content: '# Taskfile' } },
  ]
}

/**
 * Generate mock file changes - uses paths that exist in the file tree
 */
function getMockChanges(): WorkspaceFileChange[] {
  return [
    {
      path: 'src/api/main.go',
      changeType: 'modified',
      additions: 2,
      deletions: 2,
      language: 'go',
      // A larger file with a single change in the middle - demonstrates expand up/down
      originalContent: `package main

import (
	"fmt"
	"log"
	"net/http"
	"time"
)

// Config holds application configuration
type Config struct {
	Port         int
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	IdleTimeout  time.Duration
}

// DefaultConfig returns sensible defaults
func DefaultConfig() *Config {
	return &Config{
		Port:         8080,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
}

// Server wraps the HTTP server
type Server struct {
	config     *Config
	router     *http.ServeMux
	httpServer *http.Server
	logger     *log.Logger
}

// NewServer creates a new server instance
func NewServer(cfg *Config, logger *log.Logger) *Server {
	router := http.NewServeMux()
	return &Server{
		config: cfg,
		router: router,
		logger: logger,
		httpServer: &http.Server{
			Addr:         fmt.Sprintf(":%d", cfg.Port),
			Handler:      router,
			ReadTimeout:  cfg.ReadTimeout,
			WriteTimeout: cfg.WriteTimeout,
			IdleTimeout:  cfg.IdleTimeout,
		},
	}
}

// RegisterRoutes sets up all HTTP routes
func (s *Server) RegisterRoutes() {
	s.router.HandleFunc("/health", s.handleHealth)
	s.router.HandleFunc("/api/users", s.handleUsers)
	s.router.HandleFunc("/api/items", s.handleItems)
}

// handleHealth returns server health status
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

// handleUsers manages user operations
func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	// User handling logic
	s.logger.Printf("Handling users request: %s", r.Method)
}

// handleItems manages item operations
func (s *Server) handleItems(w http.ResponseWriter, r *http.Request) {
	// Item handling logic
	s.logger.Printf("Handling items request: %s", r.Method)
}

// Start begins listening for requests
func (s *Server) Start() error {
	s.logger.Printf("Server starting on port %d", s.config.Port)
	return s.httpServer.ListenAndServe()
}

// Stop gracefully shuts down the server
func (s *Server) Stop() error {
	s.logger.Println("Server shutting down")
	return nil
}

func main() {
	logger := log.Default()
	cfg := DefaultConfig()
	server := NewServer(cfg, logger)
	server.RegisterRoutes()
	
	logger.Println("Starting server...")
	if err := server.Start(); err != nil {
		logger.Fatal(err)
	}
}`,
      newContent: `package main

import (
	"fmt"
	"log"
	"net/http"
	"time"
)

// Config holds application configuration
type Config struct {
	Port         int
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	IdleTimeout  time.Duration
}

// DefaultConfig returns sensible defaults
func DefaultConfig() *Config {
	return &Config{
		Port:         8080,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
}

// Server wraps the HTTP server
type Server struct {
	config     *Config
	router     *http.ServeMux
	httpServer *http.Server
	logger     *log.Logger
}

// NewServer creates a new server instance
func NewServer(cfg *Config, logger *log.Logger) *Server {
	router := http.NewServeMux()
	return &Server{
		config: cfg,
		router: router,
		logger: logger,
		httpServer: &http.Server{
			Addr:         fmt.Sprintf(":%d", cfg.Port),
			Handler:      router,
			ReadTimeout:  cfg.ReadTimeout,
			WriteTimeout: cfg.WriteTimeout,
			IdleTimeout:  cfg.IdleTimeout,
		},
	}
}

// RegisterRoutes sets up all HTTP routes
func (s *Server) RegisterRoutes() {
	s.router.HandleFunc("/health", s.handleHealth)
	s.router.HandleFunc("/api/users", s.handleUsers)
	s.router.HandleFunc("/api/items", s.handleItems)
}

// handleHealth returns server health status
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

// handleUsers manages user operations
func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	// User handling logic with improved logging
	s.logger.Printf("Users API: %s %s", r.Method, r.URL.Path)
}

// handleItems manages item operations
func (s *Server) handleItems(w http.ResponseWriter, r *http.Request) {
	// Item handling logic with improved logging
	s.logger.Printf("Items API: %s %s", r.Method, r.URL.Path)
}

// Start begins listening for requests
func (s *Server) Start() error {
	s.logger.Printf("Server starting on port %d", s.config.Port)
	return s.httpServer.ListenAndServe()
}

// Stop gracefully shuts down the server
func (s *Server) Stop() error {
	s.logger.Println("Server shutting down")
	return nil
}

func main() {
	logger := log.Default()
	cfg := DefaultConfig()
	server := NewServer(cfg, logger)
	server.RegisterRoutes()
	
	logger.Println("Starting server...")
	if err := server.Start(); err != nil {
		logger.Fatal(err)
	}
}`,
    },
    {
      path: 'src/web/App.tsx',
      changeType: 'modified',
      additions: 4,
      deletions: 4,
      language: 'typescript',
      // File with changes at TOP and BOTTOM - creates a middle collapsed section
      originalContent: `// React Application Entry Point
import React from 'react'
import { BrowserRouter } from 'react-router-dom'

// Types
interface AppProps {
  theme?: 'light' | 'dark'
}

interface AppState {
  isLoading: boolean
  data: string | null
  error: Error | null
}

// Constants
const API_BASE_URL = '/api/v1'
const DEFAULT_THEME = 'light'

// Helper functions
function getStoredTheme(): string {
  return localStorage.getItem('theme') || DEFAULT_THEME
}

function setStoredTheme(theme: string): void {
  localStorage.setItem('theme', theme)
}

// Loading component
function LoadingSpinner() {
  return (
    <div className="spinner">
      <div className="spinner-inner" />
    </div>
  )
}

// Error boundary component  
function ErrorDisplay({ error }: { error: Error }) {
  return (
    <div className="error-container">
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
    </div>
  )
}

// Main App component
export function App({ theme = DEFAULT_THEME }: AppProps) {
  const [state, setState] = React.useState<AppState>({
    isLoading: true,
    data: null,
    error: null,
  })

  React.useEffect(() => {
    fetch(API_BASE_URL + '/data')
      .then(res => res.json())
      .then(data => setState({ isLoading: false, data, error: null }))
      .catch(error => setState({ isLoading: false, data: null, error }))
  }, [])

  if (state.isLoading) return <LoadingSpinner />
  if (state.error) return <ErrorDisplay error={state.error} />
  
  return (
    <BrowserRouter>
      <div className="app" data-theme={theme}>
        {state.data}
      </div>
    </BrowserRouter>
  )
}`,
      newContent: `// React Application Entry Point v2
import React, { useState, useEffect } from 'react'
import { BrowserRouter } from 'react-router-dom'

// Types
interface AppProps {
  theme?: 'light' | 'dark'
}

interface AppState {
  isLoading: boolean
  data: string | null
  error: Error | null
}

// Constants
const API_BASE_URL = '/api/v1'
const DEFAULT_THEME = 'light'

// Helper functions
function getStoredTheme(): string {
  return localStorage.getItem('theme') || DEFAULT_THEME
}

function setStoredTheme(theme: string): void {
  localStorage.setItem('theme', theme)
}

// Loading component
function LoadingSpinner() {
  return (
    <div className="spinner">
      <div className="spinner-inner" />
    </div>
  )
}

// Error boundary component  
function ErrorDisplay({ error }: { error: Error }) {
  return (
    <div className="error-container">
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
    </div>
  )
}

// Main App component
export function App({ theme = DEFAULT_THEME }: AppProps) {
  const [state, setState] = useState<AppState>({
    isLoading: true,
    data: null,
    error: null,
  })

  useEffect(() => {
    fetch(API_BASE_URL + '/data')
      .then(res => res.json())
      .then(data => setState({ isLoading: false, data, error: null }))
      .catch(error => setState({ isLoading: false, data: null, error }))
  }, [])

  if (state.isLoading) return <LoadingSpinner />
  if (state.error) return <ErrorDisplay error={state.error} />
  
  return (
    <BrowserRouter>
      <main className="app" data-theme={theme}>
        {state.data}
      </main>
    </BrowserRouter>
  )
}`,
    },
    {
      path: 'infra/modules/lambda/outputs.tf',
      changeType: 'deleted',
      additions: 0,
      deletions: 8,
      language: 'hcl',
      originalContent: `# Outputs for Lambda module

output "function_arn" {
  description = "ARN of the Lambda function"
  value       = aws_lambda_function.this.arn
}

output "function_name" {
  description = "Name of the Lambda function"
  value       = aws_lambda_function.this.function_name
}`,
    },
    {
      path: 'src/api/middleware.go',
      changeType: 'added',
      additions: 28,
      deletions: 0,
      language: 'go',
      originalContent: '',
      newContent: `package main

import (
	"log"
	"net/http"
	"time"
)

// LoggingMiddleware logs incoming requests
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		// Call the next handler
		next.ServeHTTP(w, r)
		
		// Log the request
		log.Printf(
			"%s %s %s",
			r.Method,
			r.RequestURI,
			time.Since(start),
		)
	})
}

// AuthMiddleware checks for valid authentication
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		if token == "" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}`,
    },
  ]
}
