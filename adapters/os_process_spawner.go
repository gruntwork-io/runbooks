package adapters

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// OsProcessSpawner implements ports.ProcessSpawner using os/exec.
type OsProcessSpawner struct{}

// NewOsProcessSpawner returns a ProcessSpawner backed by os/exec.
func NewOsProcessSpawner() *OsProcessSpawner {
	return &OsProcessSpawner{}
}

// Run executes the requested process and waits for it to exit. A non-
// zero exit code surfaces in the result, not as an error; err is non-
// nil only when the process fails to start or when ctx is cancelled.
func (s *OsProcessSpawner) Run(ctx context.Context, req ports.ProcessRequest) (ports.ProcessResult, error) {
	cmd := exec.CommandContext(ctx, req.Name, req.Args...)
	cmd.Env = req.Env
	cmd.Dir = req.WorkingDir
	if req.Stdin != nil {
		cmd.Stdin = req.Stdin
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()

	result := ports.ProcessResult{
		Stdout: stdout.Bytes(),
		Stderr: stderr.Bytes(),
	}

	// Exit code is available on the ProcessState after Run, even on
	// non-zero exit. If the process never started, ProcessState is nil.
	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
	}

	// Context cancellation trumps exit status: a process killed by the
	// context produces an ExitError, but we want callers to see the
	// cancellation rather than a misleading "non-zero exit".
	if ctxErr := ctx.Err(); ctxErr != nil {
		return result, ctxErr
	}

	// Distinguish "process ran and exited non-zero" (no error, exit code
	// in result) from "process failed to start" (error).
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		return result, nil
	}
	if runErr != nil {
		return result, fmt.Errorf("run %s: %w", req.Name, runErr)
	}
	return result, nil
}

// LookPath resolves name via the host PATH.
func (s *OsProcessSpawner) LookPath(name string) (string, error) {
	path, err := exec.LookPath(name)
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return "", fmt.Errorf("%s: %w", name, ports.ErrExecutableNotFound)
		}
		return "", err
	}
	return path, nil
}

// Compile-time check that OsProcessSpawner implements the port.
var _ ports.ProcessSpawner = (*OsProcessSpawner)(nil)
