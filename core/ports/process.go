package ports

import (
	"context"
	"errors"
	"io"
)

// ErrExecutableNotFound is returned by LookPath when an executable cannot be
// located on PATH. Adapters should wrap this so callers can detect it with
// errors.Is without depending on os/exec.
var ErrExecutableNotFound = errors.New("executable not found")

// ProcessRequest describes a process to be spawned.
type ProcessRequest struct {
	// Name is the executable name (resolved via PATH) or absolute path.
	Name string

	// Args are passed to the process (not including Name as argv[0]).
	Args []string

	// Env is the environment for the child process as KEY=VALUE pairs.
	// If nil, the adapter may use an empty environment; domain code
	// should always build this explicitly so behavior is deterministic.
	Env []string

	// WorkingDir is the child process's working directory. If empty,
	// the adapter's behavior is implementation-defined.
	WorkingDir string

	// Stdin, if non-nil, is copied to the child process's standard input.
	Stdin io.Reader
}

// ProcessResult holds the completed process's output and exit status.
type ProcessResult struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// ProcessSpawner runs child processes.
//
// The desktop adapter wraps os/exec. A hosted adapter would route
// spawning through a sandbox (gVisor, Firecracker, K8s job) so that
// untrusted runbook scripts run with resource limits and isolation.
//
// This port covers one-shot commands (git, gh, auth CLIs). The long-
// running, streaming, PTY-based exec path used by <Command> blocks
// will be introduced as a separate port in a later milestone so its
// richer surface (streaming output, signal forwarding, PTY resize) can
// be shaped deliberately.
type ProcessSpawner interface {
	// Run starts the process, waits for it to exit, and returns its
	// captured output. A non-zero exit code is returned in the result
	// (not as an error); err is non-nil only for failures to start the
	// process or for context cancellation.
	Run(ctx context.Context, req ProcessRequest) (ProcessResult, error)

	// LookPath resolves an executable name to an absolute path using
	// the spawner's view of PATH. Returns ErrExecutableNotFound if the
	// executable is not found.
	LookPath(name string) (string, error)
}
