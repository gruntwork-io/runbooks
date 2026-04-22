package services

import (
	"context"
	"fmt"
	"sync"

	"github.com/gruntwork-io/runbooks/api"
)

// serverManager owns the lifecycle of the embedded Gin API server.
//
// M2 keeps Gin running behind the desktop window — the frontend still
// reaches the runbook, exec, boilerplate, etc. endpoints over HTTP. The
// manager starts Gin lazily once the user picks a gruntbook from
// Welcome, and stops it cleanly when the user closes the gruntbook and
// returns to Welcome (so they can open a different one in the same
// session).
type serverManager struct {
	mu       sync.Mutex
	started  bool
	port     int
	config   api.ServerConfig
	shutdown func(context.Context) error
	errCh    <-chan error

	// sessions is the SessionManager shared between the embedded Gin
	// server and the IPC services. A fresh one is created on every
	// Start so each open gruntbook gets clean session state (env vars,
	// worktrees, exec counts). M4+ IPC services reach it via Sessions()
	// rather than holding their own reference — that way Stop+Start
	// (Welcome → different gruntbook) transparently rebinds them.
	sessions *api.SessionManager
}

// startInfo is the subset of state that Start returns to the caller.
type startInfo struct {
	// Port is the TCP port Gin bound to. Callers hand this to the
	// frontend so it knows where to make API requests.
	Port int
	// ErrCh fires once if Gin exits. Useful if a later milestone wants
	// to surface backend crashes in the UI; M2 ignores it.
	ErrCh <-chan error
}

// Start boots Gin if it isn't already running. Returns an error if a
// server is already running — callers must Stop it first to swap
// gruntbooks. The config's Port is forced to 0 so the kernel picks a
// free port; the actual bound port is reported back in startInfo.Port.
func (sm *serverManager) Start(cfg api.ServerConfig) (*startInfo, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.started {
		return nil, fmt.Errorf("gruntbook server is already running for %q", sm.config.GruntbookPath)
	}

	cfg.Port = 0
	sessions := api.NewSessionManager()
	cfg.Sessions = sessions

	handle, err := api.StartServerWithShutdown(cfg)
	if err != nil {
		return nil, err
	}
	cfg.Port = handle.Port

	sm.started = true
	sm.port = handle.Port
	sm.config = cfg
	sm.shutdown = handle.Shutdown
	sm.errCh = handle.ErrCh
	sm.sessions = sessions

	return &startInfo{Port: handle.Port, ErrCh: handle.ErrCh}, nil
}

// Stop gracefully shuts down the running server and waits for the
// listener goroutine to exit. It is a no-op when no server is running.
// The provided context bounds how long to wait for in-flight requests
// before forcing shutdown.
func (sm *serverManager) Stop(ctx context.Context) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if !sm.started {
		return nil
	}

	shutdownErr := sm.shutdown(ctx)
	// Drain errCh so the serve goroutine isn't blocked writing.
	<-sm.errCh

	sm.started = false
	sm.port = 0
	sm.config = api.ServerConfig{}
	sm.shutdown = nil
	sm.errCh = nil
	sm.sessions = nil

	return shutdownErr
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

// Port returns the bound port, or 0 if the server is not running.
func (sm *serverManager) Port() int {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	return sm.port
}

// Config returns the config the server was started with. Returns the
// zero value if the server has not been started.
func (sm *serverManager) Config() api.ServerConfig {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	return sm.config
}
