//go:build windows

package cmd

import (
	"os/exec"
	"syscall"
)

// detachProcAttr starts the spawned process in a new process group with
// no console window attached, so the user's terminal closing doesn't
// take it down with it. DETACHED_PROCESS (0x00000008) detaches from the
// console; CREATE_NEW_PROCESS_GROUP (0x00000200) breaks the Ctrl-C tie.
func detachProcAttr(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008 | 0x00000200,
	}
}
