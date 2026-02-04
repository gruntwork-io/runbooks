package api

import (
	"bufio"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"

	"github.com/creack/pty"
)

// =============================================================================
// ANSI Code Handling
// =============================================================================

// ansiRegex matches ANSI escape sequences for colors, cursor movement, etc.
// This includes:
// - CSI sequences: ESC [ ... letter (colors, cursor, etc.)
// - OSC sequences: ESC ] ... ST (titles, hyperlinks, etc.)
// - Character set designation: ESC ( X, ESC ) X, etc. (e.g., from tput sgr0)
// - Simple escapes: ESC followed by single char
// NOTE: This regex is duplicated in web/src/lib/logs.ts - keep in sync
var ansiRegex = regexp.MustCompile(`\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*(?:\x07|\x1b\\)|\][^\x1b]*|[()*/+\-].|[a-zA-Z])`)

// stripANSI removes ANSI escape sequences from a string
func stripANSI(s string) string {
	return ansiRegex.ReplaceAllString(s, "")
}

// =============================================================================
// PTY Support
// =============================================================================

// ptySupported returns true if PTY is supported on the current platform
func ptySupported() bool {
	// PTY is supported on Unix-like systems (Linux, macOS, BSDs)
	// Not supported on Windows
	return runtime.GOOS != "windows"
}

// defaultPTYSize is the default terminal size for PTY sessions
var defaultPTYSize = &pty.Winsize{
	Rows: 40,
	Cols: 120,
}

// outputLine represents a line of output with metadata for display
type outputLine struct {
	Line    string
	Replace bool // If true, this line should replace the previous line (progress update)
}

// =============================================================================
// PTY Output Streaming
// =============================================================================

// streamPTYOutput reads from a PTY and sends lines to the output channel.
// PTY output has special characteristics:
// - stdout and stderr are combined into a single stream
// - Progress bars use carriage returns (\r) to overwrite lines
// - Output may contain ANSI escape sequences for colors/formatting
//
// This function handles carriage returns by tracking the "current line" and
// setting the Replace flag when a carriage return triggers an update.
// ANSI codes are preserved for frontend rendering.
func streamPTYOutput(ptmx *os.File, outputChan chan<- outputLine) {
	defer ptmx.Close()

	// Use a buffered reader for efficient reading
	reader := bufio.NewReader(ptmx)
	var currentLine strings.Builder
	hadProgressUpdate := false // Track if we've sent a progress update that can be replaced

	for {
		// Read one byte at a time to handle \r properly
		b, err := reader.ReadByte()
		if err != nil {
			// Emit any remaining content in the buffer
			if currentLine.Len() > 0 {
				line := currentLine.String()
				if line != "" {
					outputChan <- outputLine{Line: line, Replace: hadProgressUpdate}
				}
			}
			return
		}

		switch b {
		case '\n':
			// Newline: emit the current line and reset
			line := currentLine.String()
			if line != "" {
				outputChan <- outputLine{Line: line, Replace: hadProgressUpdate}
			}
			currentLine.Reset()
			hadProgressUpdate = false // Next line starts fresh

		case '\r':
			// Carriage return: could be \r\n (Windows-style) or progress bar update
			// Peek at the next byte to check for \r\n
			nextByte, err := reader.Peek(1)
			if err == nil && nextByte[0] == '\n' {
				// \r\n sequence - treat as newline
				reader.ReadByte() // consume the \n
				line := currentLine.String()
				if line != "" {
					outputChan <- outputLine{Line: line, Replace: hadProgressUpdate}
				}
				currentLine.Reset()
				hadProgressUpdate = false // Next line starts fresh
			} else {
				// Progress bar style update - emit current line with replace flag
				// This allows progress updates to replace the previous line
				line := currentLine.String()
				if line != "" {
					outputChan <- outputLine{Line: line, Replace: hadProgressUpdate}
					hadProgressUpdate = true // Next update should replace this one
				}
				currentLine.Reset()
			}

		default:
			// Regular character - append to current line
			currentLine.WriteByte(b)
		}
	}
}

// waitForPTYProcess waits for the PTY child process to exit and returns a Cmd-style error.
// On macOS, closing the PTY master after the process exits is required to unblock readers.
func waitForPTYProcess(cmd *exec.Cmd, ptmx *os.File) error {
	state, err := cmd.Process.Wait()
	_ = ptmx.Close()
	if err != nil {
		return err
	}
	if state.Success() {
		return nil
	}
	return &exec.ExitError{ProcessState: state}
}

// startCommandWithPTY starts a command in a pseudo-terminal.
// Returns the PTY master file descriptor which should be used for both
// reading output and cleanup (close when done).
// The command will be started as a child process.
func startCommandWithPTY(cmd *exec.Cmd) (*os.File, error) {
	// Start command with PTY
	ptmx, err := pty.StartWithSize(cmd, defaultPTYSize)
	if err != nil {
		return nil, err
	}
	return ptmx, nil
}
