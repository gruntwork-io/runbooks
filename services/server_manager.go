package services

import (
	"context"
	"fmt"
	"sync"

	"github.com/gruntwork-io/runbooks/api"
)

// serverManager tracks the runtime state of the currently-open gruntbook
// for the desktop binary: the SessionManager (env vars, worktree state,
// per-block exec counts) and the optional ExecutableRegistry. It is
// shared across every IPC service so they all see the same view.
//
// History: through M5 this type also owned an embedded Gin HTTP server
// — the desktop window proxied /api/* requests to a local listener that
// the frontend pre-IPC migration relied on. M5.5 deleted that listener.
// The desktop binary now binds no TCP port; HTTP only exists in the
// separate `gruntbooks serve` CLI path that Playwright drives. The name
// "serverManager" is kept to minimise churn across the dozen-plus
// services that hold a reference; it now manages the gruntbook session
// state, not a server.
type serverManager struct {
	mu      sync.Mutex
	started bool
	config  api.ServerConfig

	// sessions is the SessionManager shared between every IPC service.
	// A fresh one is created on every Start so each open gruntbook gets
	// clean session state. M4+ IPC services reach it via Sessions()
	// rather than holding their own reference — that way Stop+Start
	// (Welcome → different gruntbook) transparently rebinds them.
	sessions *api.SessionManager

	// registry is the ExecutableRegistry for the open gruntbook. Nil
	// when the gruntbook runs in watch / Author Mode (which re-parses
	// on every exec instead).
	registry *api.ExecutableRegistry
}

// Start initialises the per-gruntbook session + registry state. Returns
// an error if a gruntbook is already open — callers must Stop first to
// swap gruntbooks. No HTTP listener is bound; this is in-process state
// only.
func (sm *serverManager) Start(cfg api.ServerConfig) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.started {
		return fmt.Errorf("gruntbook is already open: %q", sm.config.GruntbookPath)
	}

	sessions := api.NewSessionManager()
	cfg.Sessions = sessions

	// Build the registry up front so the IPC ExecService sees it
	// before the user can trigger an exec. Watch mode (Author Mode)
	// re-parses on each exec, so registry stays nil.
	var registry *api.ExecutableRegistry
	if cfg.UseExecutableRegistry {
		resolved, err := api.ResolveGruntbookPath(cfg.GruntbookPath)
		if err != nil {
			return fmt.Errorf("resolve gruntbook path: %w", err)
		}
		registry, err = api.NewExecutableRegistry(resolved)
		if err != nil {
			return fmt.Errorf("build executable registry: %w", err)
		}
		cfg.Registry = registry
	}

	sm.started = true
	sm.config = cfg
	sm.sessions = sessions
	sm.registry = registry

	return nil
}

// Stop clears the per-gruntbook state so the user can return to Welcome
// and open a different gruntbook. The ctx is accepted for API
// compatibility with the M5-era Gin shutdown path; nothing now blocks
// on it. No-op if no gruntbook is open.
func (sm *serverManager) Stop(_ context.Context) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if !sm.started {
		return nil
	}

	sm.started = false
	sm.config = api.ServerConfig{}
	sm.sessions = nil
	sm.registry = nil

	return nil
}

// Sessions returns the SessionManager for the currently-open gruntbook,
// or nil if no gruntbook is open. IPC services call this on every
// request (rather than caching a reference) so a Stop+Start cycle
// transparently rebinds them to the new session state.
func (sm *serverManager) Sessions() *api.SessionManager {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	return sm.sessions
}

// Registry returns the ExecutableRegistry for the currently-open
// gruntbook. Returns (nil, nil) when no gruntbook is open or when the
// gruntbook runs in watch mode. The error slot is reserved for future
// modes where registry construction can fail outside Start().
func (sm *serverManager) Registry() (*api.ExecutableRegistry, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	return sm.registry, nil
}

// Config returns the config the gruntbook was opened with. Returns the
// zero value if no gruntbook is open.
func (sm *serverManager) Config() api.ServerConfig {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	return sm.config
}
