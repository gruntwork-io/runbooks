package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Constants
// =============================================================================

// sessionExecCtxKey is the key used to store SessionExecContext in gin.Context.
// Using a constant prevents typos and makes it easy to find all usages.
const sessionExecCtxKey = "sessionExecCtx"

// =============================================================================
// Types
// =============================================================================

// SetEnvRequest represents the request body for setting environment variables.
type SetEnvRequest struct {
	Env map[string]string `json:"env" binding:"required"`
}

// =============================================================================
// Handlers
// =============================================================================

// HandleCreateSession creates a new session and returns the token.
// POST /api/session
// No authentication required.
func HandleCreateSession(sm *SessionManager, workingDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		response, err := sm.CreateSession(workingDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
			return
		}

		c.JSON(http.StatusOK, response)
	}
}

// HandleJoinSession allows a new browser tab to join an existing session.
// POST /api/session/join
// No authentication required.
func HandleJoinSession(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		response, err := sm.JoinSession()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to restore session"})
			return
		}

		if response == nil {
			// No session exists
			c.JSON(http.StatusUnauthorized, gin.H{"error": "No session exists"})
			return
		}

		c.JSON(http.StatusOK, response)
	}
}

// HandleGetSession returns session metadata (NOT environment variables).
// GET /api/session
// Requires Bearer token authentication (enforced by SessionAuthMiddleware).
func HandleGetSession(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		metadata, ok := sm.GetMetadata()
		if !ok {
			// This shouldn't happen since middleware validated the token, but handle it anyway
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}

		c.JSON(http.StatusOK, metadata)
	}
}

// HandleResetSession resets a session to its initial environment state.
// POST /api/session/reset
// Requires Bearer token authentication (enforced by SessionAuthMiddleware).
func HandleResetSession(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := sm.ResetSession(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset session"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": "Session reset to initial state"})
	}
}

// HandleDeleteSession deletes a session.
// DELETE /api/session
// Requires Bearer token authentication (enforced by SessionAuthMiddleware).
func HandleDeleteSession(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		sm.DeleteSession()
		c.JSON(http.StatusOK, gin.H{"message": "Session deleted"})
	}
}

// HandleSetSessionEnv sets environment variables in the session.
// This allows UI components (like AwsAuth) to inject environment variables
// into the session without running a script.
// PATCH /api/session/env
// Requires Bearer token authentication (enforced by SessionAuthMiddleware).
func HandleSetSessionEnv(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req SetEnvRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request: env map is required"})
			return
		}

		if len(req.Env) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "At least one environment variable is required"})
			return
		}

		if err := sm.AppendToEnv(req.Env); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to set environment variables"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": "Environment variables set", "count": len(req.Env)})
	}
}

// =============================================================================
// Middleware
// =============================================================================

// SessionAuthMiddleware validates the Bearer token and stores the session context.
// Use this middleware on routes that require session authentication.
// After this middleware runs, handlers can use GetSessionExecContext(c) to get the session.
func SessionAuthMiddleware(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractBearerToken(c)
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Missing Authorization header. Include 'Authorization: Bearer <token>' from session creation."})
			return
		}
		execCtx, valid := sm.ValidateToken(token)
		if !valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Invalid or expired session token. Try refreshing the page or restarting Runbooks."})
			return
		}
		c.Set(sessionExecCtxKey, execCtx)
		c.Next()
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

// GetSessionExecContext retrieves the SessionExecContext stored by SessionAuthMiddleware.
// Returns nil if the middleware hasn't run or the context wasn't stored.
// This should only be called in handlers protected by SessionAuthMiddleware.
func GetSessionExecContext(c *gin.Context) *SessionExecContext {
	if val, exists := c.Get(sessionExecCtxKey); exists {
		if execCtx, ok := val.(*SessionExecContext); ok {
			return execCtx
		}
	}
	return nil
}

// extractBearerToken extracts the Bearer token from the Authorization header.
func extractBearerToken(c *gin.Context) string {
	auth := c.GetHeader("Authorization")
	if auth == "" {
		return ""
	}

	// Expect "Bearer <token>"
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}

	return parts[1]
}
