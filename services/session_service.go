package services

import (
	"fmt"

	"github.com/gruntwork-io/runbooks/api"
)

// SessionService is the Wails IPC wrapper around the /api/session/*
// endpoints. Each method maps 1:1 to the legacy HTTP handler
// (HandleCreateSession, HandleJoinSession, HandleGetSession,
// HandleResetSession, HandleDeleteSession, HandleSetSessionEnv) and
// returns the same JSON shape so the frontend's useSession context
// works against both transports.
//
// The session token concept is preserved end-to-end for M4 so Gin and
// Wails share SessionManager state unchanged. M5 strips tokens when
// the HTTP surface goes away — the IPC boundary itself is the trust
// boundary.
type SessionService struct {
	servers *serverManager
}

// ServiceName satisfies application.ServiceName.
func (s *SessionService) ServiceName() string { return "SessionService" }

// Create bootstraps a new session and returns its token. The working
// directory is taken from the currently-open gruntbook's server
// config, matching HandleCreateSession where the HTTP handler
// captured it at bind time.
func (s *SessionService) Create() (*api.SessionTokenResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	cfg := s.servers.Config()
	resp, err := sessions.CreateSession(cfg.WorkingDir)
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}
	return resp, nil
}

// Join mints an additional token for an already-running session so a
// second tab (or re-mount after StrictMode) can share env state with
// the original. Returns (nil, nil) for both "no gruntbook open" and
// "no session created yet" — both are expected bootstrap states,
// indistinguishable from the frontend's point of view, and neither
// is a real error. Real errors (unexpected SessionManager failures)
// still propagate so the frontend can surface them instead of
// silently papering over them as "just no session".
func (s *SessionService) Join() (*api.SessionTokenResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, nil
	}
	resp, err := sessions.JoinSession()
	if err != nil {
		return nil, fmt.Errorf("join session: %w", err)
	}
	return resp, nil
}

// Get returns session metadata (workingDir, exec count, timestamps,
// tab count). Requires a valid token — matches the HTTP path's
// SessionAuthMiddleware guard.
func (s *SessionService) Get(sessionID string) (*api.SessionMetadata, error) {
	sessions, err := s.authed(sessionID)
	if err != nil {
		return nil, err
	}
	meta, ok := sessions.GetMetadata()
	if !ok {
		return nil, fmt.Errorf("no active session")
	}
	return meta, nil
}

// Reset restores the session's env to the snapshot captured at
// creation time. Used by the "Reset session" UI control.
func (s *SessionService) Reset(sessionID string) error {
	sessions, err := s.authed(sessionID)
	if err != nil {
		return err
	}
	return sessions.ResetSession()
}

// Delete invalidates every token and drops session state. Currently
// unused by the frontend but preserved for parity.
func (s *SessionService) Delete(sessionID string) error {
	sessions, err := s.authed(sessionID)
	if err != nil {
		return err
	}
	sessions.DeleteSession()
	return nil
}

// SessionSetEnvResult mirrors the {message, count} response from the
// HTTP handler. Named shape rather than map so the Wails TS codegen
// renders a concrete interface.
type SessionSetEnvResult struct {
	Message string `json:"message"`
	Count   int    `json:"count"`
}

// SetEnv appends env vars to the session. Used by AwsAuth and
// GitHubAuth panels to inject credentials without running a script.
func (s *SessionService) SetEnv(sessionID string, env map[string]string) (*SessionSetEnvResult, error) {
	sessions, err := s.authed(sessionID)
	if err != nil {
		return nil, err
	}
	if len(env) == 0 {
		return nil, fmt.Errorf("at least one environment variable is required")
	}
	if err := sessions.AppendToEnv(env); err != nil {
		return nil, fmt.Errorf("set env: %w", err)
	}
	return &SessionSetEnvResult{Message: "Environment variables set", Count: len(env)}, nil
}

// authed looks up the SessionManager for the current gruntbook and
// validates the provided token. Returns a typed error matching the
// HTTP handler's 401 messages — the frontend shows them verbatim.
func (s *SessionService) authed(sessionID string) (*api.SessionManager, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	if sessionID == "" {
		return nil, fmt.Errorf("missing session token")
	}
	if _, ok := sessions.ValidateToken(sessionID); !ok {
		return nil, fmt.Errorf("invalid or expired session token")
	}
	return sessions, nil
}
