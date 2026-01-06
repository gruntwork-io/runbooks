package api

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// HandleCreateSession creates a new session and returns the token.
// POST /api/session
// No authentication required.
func HandleCreateSession(sm *SessionManager, runbookPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Use runbook directory as initial working directory
		runbookDir := filepath.Dir(runbookPath)

		response, err := sm.CreateSession(runbookDir)
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
// Requires Bearer token authentication.
func HandleGetSession(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Validate token
		token := extractBearerToken(c)
		if token == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Missing Authorization header. Include 'Authorization: Bearer <token>' from session creation."})
			return
		}
		if _, valid := sm.ValidateToken(token); !valid {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid or expired session token. Try refreshing the page or restarting Runbooks."})
			return
		}

		metadata, ok := sm.GetMetadata()
		if !ok {
			// This shouldn't happen since we just validated the token, but handle it anyway
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}

		c.JSON(http.StatusOK, metadata)
	}
}

// HandleResetSession resets a session to its initial environment state.
// POST /api/session/reset
// Requires Bearer token authentication.
func HandleResetSession(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Validate token
		token := extractBearerToken(c)
		if token == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Missing Authorization header. Include 'Authorization: Bearer <token>' from session creation."})
			return
		}
		if _, valid := sm.ValidateToken(token); !valid {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid or expired session token. Try refreshing the page or restarting Runbooks."})
			return
		}

		if err := sm.ResetSession(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset session"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": "Session reset to initial state"})
	}
}

// HandleDeleteSession deletes a session.
// DELETE /api/session
// Requires Bearer token authentication.
func HandleDeleteSession(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Validate token
		token := extractBearerToken(c)
		if token == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Missing Authorization header. Include 'Authorization: Bearer <token>' from session creation."})
			return
		}
		if _, valid := sm.ValidateToken(token); !valid {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid or expired session token. Try refreshing the page or restarting Runbooks."})
			return
		}

		sm.DeleteSession()
		c.JSON(http.StatusOK, gin.H{"message": "Session deleted"})
	}
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
