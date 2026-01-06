package api

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// MaxTokensPerSession limits the number of concurrent tokens (browser tabs).
// This prevents unbounded memory growth if tabs are opened repeatedly.
//
// Tokens are cryptographically random strings used to authenticate API requests.
// Each browser tab receives its own token when it connects (via CreateSession or
// RestoreSession). The token must be included as a Bearer token in the Authorization
// header for protected endpoints like /api/exec. This prevents unauthorized processes
// from executing scripts, even though the server only listens on localhost.
const MaxTokensPerSession = 20

// Session represents a persistent execution environment for a runbook session.
// Environment changes made by scripts persist across block executions.
// Multiple browser tabs can share the same session, each with their own token.
type Session struct {
	// ValidTokens maps each active token to its creation time.
	// Multiple tokens allow multiple browser tabs to share the same session
	// without invalidating each other. Uses a map for O(1) lookup during validation.
	ValidTokens    map[string]time.Time // token -> created time
	Env            map[string]string    // Current environment state (NEVER exposed via API)
	InitialEnv     map[string]string    // Snapshot at creation (for reset)
	InitialWorkDir string               // Initial working directory (for reset)
	WorkingDir     string               // Current working directory
	ExecutionCount int                  // Global execution counter
	CreatedAt      time.Time
	LastActivity   time.Time
}

// SessionMetadata is the public-safe subset of Session returned by GET endpoints.
// Environment variables are intentionally excluded for security.
type SessionMetadata struct {
	WorkingDir     string    `json:"workingDir"`
	ExecutionCount int       `json:"executionCount"`
	CreatedAt      time.Time `json:"createdAt"`
	LastActivity   time.Time `json:"lastActivity"`
	ActiveTabs     int       `json:"activeTabs"` // Number of active tokens (browser tabs)
}

// SessionTokenResponse is returned when creating or restoring a session.
type SessionTokenResponse struct {
	Token string `json:"token"`
}

// SessionManager provides thread-safe access to the single active session.
//
// Why a manager for a single session?
//   - Thread safety: Multiple HTTP handlers access the session concurrently
//   - Nil handling: Session doesn't exist until first API call; manager handles this cleanly
//   - Atomic operations: Create/replace session atomically without race conditions
//   - Encapsulation: All session logic (create, validate, restore) in one place
//   - Testability: Each test gets a fresh manager instance
//
// The session persists for the lifetime of the server process. All browser
// tabs share the same session, which matches the mental model of "one runbook
// = one environment" (like having multiple terminal windows to the same shell).
// Each tab gets its own token, but they all operate on the same environment.
type SessionManager struct {
	session *Session     // The single session, nil until created
	mu      sync.RWMutex // Protects concurrent access to session
}

// NewSessionManager creates a new session manager with no active session.
// Call CreateSession() to initialize the session when the first client connects.
func NewSessionManager() *SessionManager {
	return &SessionManager{}
}

// generateSecretToken generates a cryptographically secure random token.
func generateSecretToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("failed to generate secret token: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

// captureEnvironment captures the current process environment as a map.
func captureEnvironment() map[string]string {
	env := make(map[string]string)
	for _, e := range os.Environ() {
		if idx := strings.Index(e, "="); idx != -1 {
			key := e[:idx]
			value := e[idx+1:]
			env[key] = value
		}
	}
	return env
}

// copyEnvMap creates a deep copy of an environment map.
func copyEnvMap(src map[string]string) map[string]string {
	dst := make(map[string]string, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

// CreateSession creates a new session with the current process environment.
// If a session already exists, it is replaced (all existing tokens invalidated).
// The initialWorkingDir should be the runbook's directory.
func (sm *SessionManager) CreateSession(initialWorkingDir string) (*SessionTokenResponse, error) {
	token, err := generateSecretToken()
	if err != nil {
		return nil, err
	}

	// Resolve to absolute path
	absWorkingDir, err := filepath.Abs(initialWorkingDir)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve working directory: %w", err)
	}

	env := captureEnvironment()
	now := time.Now()

	session := &Session{
		ValidTokens:    map[string]time.Time{token: now},
		Env:            env,
		InitialEnv:     copyEnvMap(env),
		InitialWorkDir: absWorkingDir,
		WorkingDir:     absWorkingDir,
		ExecutionCount: 0,
		CreatedAt:      now,
		LastActivity:   now,
	}

	sm.mu.Lock()
	sm.session = session // Replace any existing session
	sm.mu.Unlock()

	return &SessionTokenResponse{
		Token: token,
	}, nil
}

// GetSession retrieves the current session (internal use only).
func (sm *SessionManager) GetSession() (*Session, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	if sm.session == nil {
		return nil, false
	}

	return sm.session, true
}

// HasSession returns true if a session exists.
func (sm *SessionManager) HasSession() bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.session != nil
}

// ValidateToken verifies that the provided token is one of the session's valid tokens.
// Returns the session if valid, nil otherwise.
func (sm *SessionManager) ValidateToken(token string) (*Session, bool) {
	sm.mu.RLock()
	session := sm.session
	sm.mu.RUnlock()

	if session == nil {
		// No session exists, but still do a comparison to prevent timing attacks
		_ = token == "dummy-comparison-to-prevent-timing-attack"
		return nil, false
	}

	// Check if token is in the valid tokens map
	sm.mu.RLock()
	_, valid := session.ValidTokens[token]
	sm.mu.RUnlock()

	if !valid {
		return nil, false
	}

	return session, true
}

// JoinSession creates a new token for an existing session (useful for new browser tabs).
// Unlike CreateSession, this preserves the session's environment state.
// Returns nil if no session exists.
func (sm *SessionManager) JoinSession() (*SessionTokenResponse, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.session == nil {
		return nil, nil // No session exists
	}

	// Generate new token
	token, err := generateSecretToken()
	if err != nil {
		return nil, err
	}

	// If we've hit the max tokens, remove the oldest one
	if len(sm.session.ValidTokens) >= MaxTokensPerSession {
		sm.pruneOldestToken()
	}

	// Add the new token
	sm.session.ValidTokens[token] = time.Now()
	sm.session.LastActivity = time.Now()

	return &SessionTokenResponse{
		Token: token,
	}, nil
}

// pruneOldestToken removes the oldest token from the session.
// Caller must hold the write lock.
func (sm *SessionManager) pruneOldestToken() {
	var oldestToken string
	var oldestTime time.Time

	for token, created := range sm.session.ValidTokens {
		if oldestToken == "" || created.Before(oldestTime) {
			oldestToken = token
			oldestTime = created
		}
	}

	if oldestToken != "" {
		delete(sm.session.ValidTokens, oldestToken)
	}
}

// RevokeToken removes a specific token from the session (for tab close cleanup).
// Returns true if the token was found and removed.
func (sm *SessionManager) RevokeToken(token string) bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.session == nil {
		return false
	}

	if _, exists := sm.session.ValidTokens[token]; exists {
		delete(sm.session.ValidTokens, token)
		return true
	}

	return false
}

// UpdateSessionEnv updates the session's environment and working directory after script execution.
func (sm *SessionManager) UpdateSessionEnv(env map[string]string, workDir string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.session == nil {
		return fmt.Errorf("no active session")
	}

	sm.session.Env = env
	sm.session.WorkingDir = workDir
	sm.session.ExecutionCount++
	sm.session.LastActivity = time.Now()

	return nil
}

// ResetSession restores the session to its initial environment state.
func (sm *SessionManager) ResetSession() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.session == nil {
		return fmt.Errorf("no active session")
	}

	sm.session.Env = copyEnvMap(sm.session.InitialEnv)
	sm.session.WorkingDir = sm.session.InitialWorkDir
	sm.session.LastActivity = time.Now()

	return nil
}

// DeleteSession removes the current session (invalidates all tokens).
func (sm *SessionManager) DeleteSession() {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.session = nil
}

// GetMetadata returns the public-safe metadata for the session.
func (sm *SessionManager) GetMetadata() (*SessionMetadata, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	if sm.session == nil {
		return nil, false
	}

	return &SessionMetadata{
		WorkingDir:     sm.session.WorkingDir,
		ExecutionCount: sm.session.ExecutionCount,
		CreatedAt:      sm.session.CreatedAt,
		LastActivity:   sm.session.LastActivity,
		ActiveTabs:     len(sm.session.ValidTokens),
	}, true
}

// TokenCount returns the number of valid tokens (active browser tabs).
func (sm *SessionManager) TokenCount() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	if sm.session == nil {
		return 0
	}

	return len(sm.session.ValidTokens)
}

// EnvSlice converts the session's environment map to a slice for use with exec.Cmd.
func (s *Session) EnvSlice() []string {
	result := make([]string, 0, len(s.Env))
	for k, v := range s.Env {
		result = append(result, k+"="+v)
	}
	return result
}

// excludedEnvVars are environment variables that should not be captured/overwritten
// because they are shell internals or change with each execution.
var excludedEnvVars = map[string]bool{
	"_":                     true, // Last command
	"SHLVL":                 true, // Shell level
	"OLDPWD":                true, // Previous directory (we track workdir separately)
	"FUNCNAME":              true, // Bash function name stack
	"LINENO":                true, // Current line number
	"RANDOM":                true, // Random number
	"SECONDS":               true, // Seconds since shell start
	"EPOCHSECONDS":          true, // Unix timestamp (changes every second)
	"EPOCHREALTIME":         true, // Unix timestamp with microseconds
	"BASHPID":               true, // PID of current bash process (differs in subshells)
	"BASH_COMMAND":          true, // Currently executing command
	"BASH_SUBSHELL":         true, // Subshell nesting level
	"BASH_EXECUTION_STRING": true, // Command passed to -c option
	"PPID":             	 true, // Parent PID - wrong in new shell
	"BASH_LINENO":      	 true, // Call stack line numbers (array)
	"BASH_SOURCE":      	 true, // Call stack source files (array)
	"BASH_ARGC":        	 true, // Arg count stack
	"BASH_ARGV":        	 true, // Arg value stack
	"BASH_REMATCH":     	 true, // Regex match results
	"PIPESTATUS":       	 true, // Exit codes of last pipeline
	"HISTCMD":          	 true, // History number of current command
	"SRANDOM":          	 true, // 32-bit random (bash 5.1+)

	// Internal wrapper variables
	"ENV_CAPTURE_FILE": 	true,
	"PWD_CAPTURE_FILE": 	true,
}

// FilterCapturedEnv filters out shell-internal variables from captured environment.
func FilterCapturedEnv(env map[string]string) map[string]string {
	filtered := make(map[string]string, len(env))
	for k, v := range env {
		// Skip excluded vars
		if excludedEnvVars[k] {
			continue
		}
		// Skip BASH_* variables (there are many)
		if strings.HasPrefix(k, "BASH_") {
			continue
		}
		filtered[k] = v
	}
	return filtered
}
