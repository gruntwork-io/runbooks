//go:build !windows

package cmd

import (
	"os/exec"
	"syscall"
)

// detachProcAttr puts the spawned process in its own session so it
// becomes a direct child of init and survives the parent (this CLI)
// exiting. Without Setsid the child inherits the parent's controlling
// terminal and dies when the terminal is closed.
func detachProcAttr(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
