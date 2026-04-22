package services

import (
	"fmt"
	"net"
	"sync"

	"github.com/gruntwork-io/runbooks/api"
)

// serverManager owns the lifecycle of the embedded Gin API server.
//
// M2 keeps Gin running behind the desktop window — the frontend still
// reaches the runbook, exec, boilerplate, etc. endpoints over HTTP. The
// manager exists so we can start Gin lazily (only once the user picks
// a gruntbook from the Welcome screen) and make sure we only ever have
// one instance per desktop process, regardless of how many IPC callers
// trigger Open*.
//
// The server currently cannot be stopped cleanly: api.StartServer
// blocks on r.Run() and gin exposes no shutdown hook. That's fine for
// M2's single-view scope — once a gruntbook is open, the user quits
// the whole app to reset. Later milestones that add multi-runbook or
// in-app runbook-switching will need a proper Shutdown path.
type serverManager struct {
	mu      sync.Mutex
	started bool
	port    int
	config  api.ServerConfig
	errCh   chan error
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

// Start boots Gin if it isn't already running. Calling Start a second
// time with any config is an error: M2 is single-gruntbook-per-desktop.
// The config's Port is replaced with a kernel-assigned free port so
// we never collide with a prior `gruntbooks open` on 7825.
func (sm *serverManager) Start(cfg api.ServerConfig) (*startInfo, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.started {
		return nil, fmt.Errorf("gruntbook server is already running for %q; quit and relaunch to open a different gruntbook", sm.config.GruntbookPath)
	}

	port, err := reserveFreePort()
	if err != nil {
		return nil, fmt.Errorf("reserve server port: %w", err)
	}
	cfg.Port = port

	errCh := make(chan error, 1)
	go func() { errCh <- api.StartServer(cfg) }()

	sm.started = true
	sm.port = port
	sm.config = cfg
	sm.errCh = errCh

	return &startInfo{Port: port, ErrCh: errCh}, nil
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
