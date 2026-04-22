package services

import (
	"context"
	"fmt"
	"net"
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
// gruntbooks. The config's Port is replaced with a kernel-assigned free
// port so we never collide with a prior `gruntbooks open` on 7825.
func (sm *serverManager) Start(cfg api.ServerConfig) (*startInfo, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.started {
		return nil, fmt.Errorf("gruntbook server is already running for %q", sm.config.GruntbookPath)
	}

	port, err := reserveFreePort()
	if err != nil {
		return nil, fmt.Errorf("reserve server port: %w", err)
	}
	cfg.Port = port

	shutdown, errCh, err := api.StartServerWithShutdown(cfg)
	if err != nil {
		return nil, err
	}

	sm.started = true
	sm.port = port
	sm.config = cfg
	sm.shutdown = shutdown
	sm.errCh = errCh

	return &startInfo{Port: port, ErrCh: errCh}, nil
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

	return shutdownErr
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

// reserveFreePort asks the kernel for a free TCP port on 127.0.0.1 and
// immediately releases it. There's a small race window where another
// process could grab the port before Gin does, but in practice the
// gap is microseconds and the symptom (gin fails to bind) is loud.
func reserveFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
