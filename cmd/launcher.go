package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/gruntwork-io/runbooks/api"
)

// spawnDesktop re-execs the current binary as a detached child running
// `gruntbooks desktop ...` and returns immediately, freeing the user's
// terminal. The detached child becomes a child of init (pid 1 on Unix)
// and outlives this process. If a desktop window is already open, the
// SingleInstanceLock in `desktop.Run` forwards the args to the existing
// instance and the child exits — so the user can run `gruntbooks open
// foo` repeatedly to open additional gruntbooks (future tabs).
//
// path is the user-provided GRUNTBOOK_SOURCE: a local path, a remote URL,
// or a TF module directory. We resolve local paths to absolute here so
// the detached child doesn't inherit the parent's working directory
// expectation. Remote URLs and ::keyword forms pass through untouched.
//
// extraArgs are appended after the path (e.g. ["--author"]).
func spawnDesktop(path string, extraArgs ...string) error {
	resolved := resolveDesktopArg(path)

	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable: %w", err)
	}

	args := append([]string{"desktop", resolved}, extraArgs...)
	c := exec.Command(binary, args...)

	// Detach stdio so closing the terminal doesn't kill the desktop.
	c.Stdin = nil
	c.Stdout = nil
	c.Stderr = nil
	detachProcAttr(c)

	if err := c.Start(); err != nil {
		return fmt.Errorf("spawn desktop process: %w", err)
	}
	// Release the child immediately — Wait() would block this process.
	return c.Process.Release()
}

// resolveDesktopArg turns a user-provided path into something the
// desktop command can resolve. Remote URLs (https://, github.com/...)
// and `::keyword` forms pass through; local paths are made absolute so
// the detached child isn't relying on this CLI's CWD.
func resolveDesktopArg(path string) string {
	if path == "" {
		return ""
	}
	// Remote URLs: leave as-is.
	if parsed, err := api.ParseRemoteSource(path); err == nil && parsed != nil {
		return path
	}
	// `::tofu`, `::terragrunt`, etc. — leave as-is.
	if len(path) >= 2 && path[:2] == "::" {
		return path
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}
