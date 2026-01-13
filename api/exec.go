package api

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ExecRequest represents the request to execute a script
type ExecRequest struct {
	ExecutableID      string            `json:"executable_id,omitempty"` // Used when useExecutableRegistry=true
	ComponentID       string            `json:"component_id,omitempty"`  // Used when useExecutableRegistry=false
	TemplateVarValues map[string]string `json:"template_var_values"`     // Values for template variables
}

// ExecLogEvent represents a log line event sent via SSE
type ExecLogEvent struct {
	Line      string `json:"line"`
	Timestamp string `json:"timestamp"`
}

// ExecStatusEvent represents the final status event sent via SSE
type ExecStatusEvent struct {
	Status   string `json:"status"` // "success", "fail"
	ExitCode int    `json:"exitCode"`
}

// FilesCapturedEvent represents files captured from script execution
type FilesCapturedEvent struct {
	Files    []CapturedFile `json:"files"`    // List of captured files
	Count    int            `json:"count"`    // Total number of files captured
	FileTree any            `json:"fileTree"` // Updated file tree for the workspace
}

// CapturedFile represents a single file captured from script output
type CapturedFile struct {
	Path string `json:"path"` // Relative path within the output directory
	Size int64  `json:"size"` // File size in bytes
}

// HandleExecRequest handles the execution of scripts and streams output via SSE
func HandleExecRequest(registry *ExecutableRegistry, runbookPath string, useExecutableRegistry bool, cliOutputPath string, sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req ExecRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		// Validate session token if Authorization header is provided
		var execCtx *SessionExecContext
		token := extractBearerToken(c)
		if token != "" {
			var valid bool
			execCtx, valid = sessionManager.ValidateToken(token)
			if !valid {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid or expired session token. Try refreshing the page or restarting Runbooks."})
				return
			}
		}

		var executable *Executable
		var err error

		if useExecutableRegistry {
			// Registry mode: Validate against registry
			if req.ExecutableID == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "executable_id is required"})
				return
			}

			var ok bool
			executable, ok = registry.GetExecutable(req.ExecutableID)
			if !ok {
				c.JSON(http.StatusNotFound, gin.H{"error": "Executable not found in registry"})
				return
			}
		} else {
			// Live reload mode: Parse runbook on-demand
			if req.ComponentID == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "component_id is required"})
				return
			}

			executable, err = getExecutableByComponentID(runbookPath, req.ComponentID)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Failed to find component: %v", err)})
				return
			}
		}

		// Get script content
		scriptContent := executable.ScriptContent

		// If this executable has template variables, render them with provided values
		if len(executable.TemplateVarNames) > 0 && len(req.TemplateVarValues) > 0 {
			rendered, err := renderBoilerplateContent(scriptContent, req.TemplateVarValues)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Failed to render template: %v", err)})
				return
			}
			scriptContent = rendered
		}

		// Create capture directory for RUNBOOKS_OUTPUT
		// Scripts can write files here to have them captured to the output directory
		captureDir, err := os.MkdirTemp("", "runbook-output-*")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to create capture directory: %v", err)})
			return
		}
		defer os.RemoveAll(captureDir)

		// Set up SSE headers
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("Transfer-Encoding", "chunked")

		// Create temp files for environment capture (used to capture env changes after script execution)
		var envCapturePath, pwdCapturePath string
		if execCtx != nil {
			envFile, err := os.CreateTemp("", "runbook-env-capture-*.txt")
			if err != nil {
				sendSSEError(c, fmt.Sprintf("Failed to create env capture file: %v", err))
				return
			}
			envCapturePath = envFile.Name()
			envFile.Close()
			defer os.Remove(envCapturePath)

			pwdFile, err := os.CreateTemp("", "runbook-pwd-capture-*.txt")
			if err != nil {
				sendSSEError(c, fmt.Sprintf("Failed to create pwd capture file: %v", err))
				return
			}
			pwdCapturePath = pwdFile.Name()
			pwdFile.Close()
			defer os.Remove(pwdCapturePath)
		}

		// Create a temporary file for the script
		tmpFile, err := os.CreateTemp("", "runbook-check-*.sh")
		if err != nil {
			sendSSEError(c, fmt.Sprintf("Failed to create temp file: %v", err))
			return
		}
		defer os.Remove(tmpFile.Name())

		// Detect interpreter from shebang or use language from executable
		// We need this BEFORE deciding whether to wrap, so we can skip wrapping for non-bash scripts
		interpreter, args := detectInterpreter(scriptContent, executable.Language)

		// Write script content to temp file
		// If we have a session AND the script is bash-compatible, wrap to capture environment changes.
		// Non-bash scripts (Python, Ruby, etc.) cannot have their environment changes captured because:
		// 1. The wrapper is bash code that wouldn't be valid in other interpreters
		// 2. Even if we ran non-bash scripts separately, their os.environ changes only affect
		//    their own subprocess and wouldn't propagate back to the session
		scriptToWrite := scriptContent
		isBashCompatible := isBashInterpreter(interpreter)
		if execCtx != nil && isBashCompatible {
			scriptToWrite = wrapScriptForEnvCapture(scriptContent, envCapturePath, pwdCapturePath)
		}

		if _, err := tmpFile.WriteString(scriptToWrite); err != nil {
			tmpFile.Close()
			sendSSEError(c, fmt.Sprintf("Failed to write script: %v", err))
			return
		}

		// Make the file executable
		if err := os.Chmod(tmpFile.Name(), 0700); err != nil {
			tmpFile.Close()
			sendSSEError(c, fmt.Sprintf("Failed to make script executable: %v", err))
			return
		}
		tmpFile.Close()

		// Create context with 5 minute timeout
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		// Prepare command
		cmdArgs := append(args, tmpFile.Name())
		cmd := exec.CommandContext(ctx, interpreter, cmdArgs...)

		// Set environment variables
		// If we have a session, use the session's environment; otherwise use the process environment
		if execCtx != nil {
			cmd.Env = execCtx.Env
		} else {
			cmd.Env = os.Environ()
		}

		// Add RUNBOOKS_OUTPUT environment variable
		// Scripts can write files to this directory to have them captured to the output
		cmd.Env = append(cmd.Env, "RUNBOOKS_OUTPUT="+captureDir)

		// Set working directory from session if available
		if execCtx != nil {
			cmd.Dir = execCtx.WorkDir
		}

		// Get stdout and stderr pipes
		stdoutPipe, err := cmd.StdoutPipe()
		if err != nil {
			sendSSEError(c, fmt.Sprintf("Failed to create stdout pipe: %v", err))
			return
		}

		stderrPipe, err := cmd.StderrPipe()
		if err != nil {
			sendSSEError(c, fmt.Sprintf("Failed to create stderr pipe: %v", err))
			return
		}

		// Start the command
		if err := cmd.Start(); err != nil {
			sendSSEError(c, fmt.Sprintf("Failed to start script: %v", err))
			return
		}

		// Create channels for streaming output
		outputChan := make(chan string, 100)
		doneChan := make(chan error, 1)

		// Stream stdout
		go streamOutput(stdoutPipe, outputChan)

		// Stream stderr
		go streamOutput(stderrPipe, outputChan)

		// Wait for command to complete
		go func() {
			doneChan <- cmd.Wait()
		}()

		// Flush writer for SSE
		flusher, ok := c.Writer.(http.Flusher)
		if !ok {
			sendSSEError(c, "Streaming not supported")
			return
		}

		// Stream logs and wait for completion
		for {
			select {
			case line := <-outputChan:
				sendSSELog(c, line)
				flusher.Flush()

			case err := <-doneChan:
				// Send any remaining logs
				for len(outputChan) > 0 {
					line := <-outputChan
					sendSSELog(c, line)
					flusher.Flush()
				}

				// Determine exit code and status
				exitCode := 0
				status := "success"

				if err != nil {
					if exitErr, ok := err.(*exec.ExitError); ok {
						exitCode = exitErr.ExitCode()
					} else if ctx.Err() == context.DeadlineExceeded {
						exitCode = -1
						status = "fail"
						sendSSELog(c, "Script execution timed out after 5 minutes")
						flusher.Flush()
					} else {
						exitCode = 1
						status = "fail"
					}
				}

				// Map exit code to status
				if exitCode == 0 {
					status = "success"
				} else if exitCode == 2 {
					status = "warn"
				} else {
					status = "fail"
				}

				// Send final status event
				sendSSEStatus(c, status, exitCode)
				flusher.Flush()

				// Update session environment if we have a session, the script is bash-compatible, and execution succeeded.
				// We capture env even on warnings since the script may have made partial changes.
				// Non-bash scripts (Python, Ruby, etc.) don't get environment capture - their env changes
				// only affect their own subprocess and can't propagate back to the session.
				if execCtx != nil && isBashCompatible && (status == "success" || status == "warn") {
					capturedEnv, capturedPwd := parseEnvCapture(envCapturePath, pwdCapturePath)
					if capturedEnv != nil {
						// Filter out shell internals
						filteredEnv := FilterCapturedEnv(capturedEnv)
						// Determine new working directory (use captured pwd, or fall back to the original)
						newWorkDir := execCtx.WorkDir
						if capturedPwd != "" {
							newWorkDir = capturedPwd
						}
						// Update session (ignore errors, non-critical)
						if err := sessionManager.UpdateSessionEnv(filteredEnv, newWorkDir); err != nil {
							// If the session was deleted concurrently, we can't update it.
							// Log a warning to the user's console.
							// TODO: Surface this warning in the UI, perhaps with a toaster notification
							sendSSELog(c, fmt.Sprintf("Warning: could not persist environment changes: %v", err))
						}
					}
				}

				// Capture files from RUNBOOKS_OUTPUT if execution was successful (or warning)
				// Scripts can write files to $RUNBOOKS_OUTPUT to have them captured
				if status == "success" || status == "warn" {
					capturedFiles, captureErr := copyFilesFromCaptureDir(captureDir, cliOutputPath)
					if captureErr != nil {
						sendSSELog(c, fmt.Sprintf("Warning: Failed to capture files: %v", captureErr))
						flusher.Flush()
					} else if len(capturedFiles) > 0 {
						sendSSEFilesCaptured(c, capturedFiles, cliOutputPath)
						flusher.Flush()
					}
				}

				// Send done event
				sendSSEDone(c)
				flusher.Flush()
				return
			}
		}
	}
}

// wrapScriptForEnvCapture wraps a script to capture environment changes after execution.
// The wrapper appends commands to dump the environment and working directory to temp files.
//
// ## How the wrapper works
//
// The wrapper executes in the same shell context as the user script, allowing environment
// variable changes (export FOO=bar) and directory changes (cd /somewhere) to be captured.
// When the script exits (normally or via explicit `exit`), we dump the environment using
// `env -0` (NUL-terminated to handle values with embedded newlines like RSA keys or JSON)
// and the working directory using `pwd`.
//
// ## The trap override problem
//
// A key challenge is that user scripts may set their own EXIT traps (e.g., for cleanup):
//
//	trap "rm -rf $TEMP_DIR" EXIT
//
// In bash, only one trap handler can exist per signal. If we naively set our own EXIT trap
// at the start of the wrapper, the user's trap would override it, and we'd never capture
// the environment.
//
// ## Solution: Intercept the trap builtin
//
// We solve this by defining a shell function named `trap` that shadows the builtin.
// When the user script calls `trap "cleanup" EXIT`, our function intercepts it:
//
//  1. We detect it's an EXIT trap (signal 0 or "EXIT")
//  2. We save the user's handler string to __RUNBOOKS_USER_EXIT_HANDLER
//  3. We return without actually setting the trap (so ours remains active)
//
// For non-EXIT traps (e.g., SIGINT, SIGTERM), we pass through to `builtin trap`.
//
// Our combined exit handler (__runbooks_combined_exit) runs when the script exits and:
//  1. Executes the user's saved handler first (so their cleanup runs)
//  2. Then captures the environment
//  3. Preserves the original exit code
//
// We use `builtin trap` to set our handler, which bypasses our override function.
func wrapScriptForEnvCapture(script, envCapturePath, pwdCapturePath string) string {
	// We use `env -0` to output NUL-terminated entries instead of newline-terminated.
	// This is critical because environment variable values can contain embedded newlines
	// (e.g., RSA keys, JSON, multiline strings). Both GNU and BSD/macOS support `env -0`.
	wrapper := fmt.Sprintf(`#!/bin/bash
# =============================================================================
# Runbooks Environment Capture Wrapper
# =============================================================================
# This wrapper captures environment changes after the user script runs.
# It intercepts EXIT traps to ensure both user cleanup AND env capture run.
#
# Flow:
#   1. Define our capture function and trap override
#   2. Set our combined EXIT handler (using builtin to bypass override)
#   3. Execute user script (which may call 'trap ... EXIT')
#   4. On exit: run user's handler first, then capture env
# =============================================================================

__RUNBOOKS_ENV_CAPTURE_PATH=%q
__RUNBOOKS_PWD_CAPTURE_PATH=%q

# -----------------------------------------------------------------------------
# Environment capture function
# Called on exit to dump env vars and working directory to temp files
# -----------------------------------------------------------------------------
__runbooks_capture_env() {
    # Use env -0 for NUL-terminated output to handle values with embedded newlines
    # (e.g., RSA keys, JSON, multiline strings)
    env -0 > "$__RUNBOOKS_ENV_CAPTURE_PATH" 2>/dev/null
    pwd > "$__RUNBOOKS_PWD_CAPTURE_PATH" 2>/dev/null
}

# -----------------------------------------------------------------------------
# Trap override mechanism
# -----------------------------------------------------------------------------
# In bash, only one handler can exist per signal. If the user script sets an
# EXIT trap, it would override ours and we'd lose env capture. To solve this,
# we define a function named 'trap' that shadows the builtin.
#
# When user calls: trap "rm -rf $TEMP_DIR" EXIT
# Our function:
#   1. Detects it's an EXIT trap
#   2. Saves the handler to __RUNBOOKS_USER_EXIT_HANDLER
#   3. Returns without setting the actual trap (ours remains active)
#
# For non-EXIT traps, we pass through to 'builtin trap' so they work normally.
# -----------------------------------------------------------------------------

# Store user's EXIT trap handler (if they set one)
__RUNBOOKS_USER_EXIT_HANDLER=""

# Override the trap builtin to intercept EXIT handlers
trap() {
    # Check if EXIT (or signal 0, which is equivalent) is in the arguments
    local has_exit=false
    local i
    for i in "$@"; do
        if [[ "$i" == "EXIT" || "$i" == "0" ]]; then
            has_exit=true
            break
        fi
    done

    if $has_exit && [[ $# -ge 2 ]]; then
        # This is setting an EXIT trap - intercept it
        local handler="$1"
        if [[ "$handler" == "-" ]]; then
            # trap - EXIT: reset to default (clear user handler)
            __RUNBOOKS_USER_EXIT_HANDLER=""
        elif [[ -z "$handler" ]]; then
            # trap '' EXIT: ignore signal (clear user handler)
            __RUNBOOKS_USER_EXIT_HANDLER=""
        else
            # Save user's handler to call during exit
            __RUNBOOKS_USER_EXIT_HANDLER="$handler"
        fi
        return 0
    fi

    # Not an EXIT trap (or just querying) - pass through to builtin
    builtin trap "$@"
}

# -----------------------------------------------------------------------------
# Combined exit handler
# Runs when script exits to execute user cleanup AND capture environment
# -----------------------------------------------------------------------------
__runbooks_combined_exit() {
    local exit_code=$?

    # Run user's EXIT handler first (if any), so their cleanup happens
    if [[ -n "$__RUNBOOKS_USER_EXIT_HANDLER" ]]; then
        eval "$__RUNBOOKS_USER_EXIT_HANDLER" || true
    fi

    # Then capture environment (after user's changes but before exit)
    __runbooks_capture_env

    # Preserve the original exit code
    exit $exit_code
}

# Set our combined exit handler using 'builtin trap' to bypass our override
builtin trap __runbooks_combined_exit EXIT

# =============================================================================
# USER SCRIPT BEGIN
# =============================================================================
%s
# =============================================================================
# USER SCRIPT END
# =============================================================================
`, envCapturePath, pwdCapturePath, script)

	return wrapper
}

// parseEnvCapture reads the captured environment and working directory from temp files.
// The environment file is expected to be NUL-terminated (from `env -0`) to correctly
// handle environment variable values that contain embedded newlines.
// Falls back to newline-delimited parsing if no NUL characters are found (for compatibility
// with systems where `env -0` might not be available).
func parseEnvCapture(envCapturePath, pwdCapturePath string) (map[string]string, string) {
	env := make(map[string]string)

	// Read environment capture
	envData, err := os.ReadFile(envCapturePath)
	if err != nil {
		// File not existing is expected if script failed early; other errors should be logged
		if !errors.Is(err, os.ErrNotExist) {
			slog.Warn("Failed to read environment capture file", "path", envCapturePath, "error", err)
		}
	} else {
		data := string(envData)

		// Auto-detect format: if NUL characters are present, use NUL-delimited parsing
		// (from `env -0`), otherwise fall back to newline-delimited (legacy/fallback)
		if strings.Contains(data, "\x00") {
			// NUL-delimited: each entry is a complete KEY=VALUE pair
			for _, entry := range strings.Split(data, "\x00") {
				if entry == "" {
					continue
				}
				if idx := strings.Index(entry, "="); idx != -1 {
					env[entry[:idx]] = entry[idx+1:]
				}
			}
		} else {
			// Newline-delimited fallback: must handle multiline values by detecting
			// continuation lines (lines that don't start a new KEY=VALUE pair)
			var currentKey string
			var valueLines []string

			for _, line := range strings.Split(data, "\n") {
				// Check if this line starts a new KEY=VALUE pair
				// A new pair has format: VALID_ENV_NAME=value
				// where VALID_ENV_NAME starts with letter/underscore and contains only [A-Za-z0-9_]
				idx := strings.Index(line, "=")
				if idx > 0 && isValidEnvVarName(line[:idx]) {
					// Save previous key-value if any
					if currentKey != "" {
						env[currentKey] = strings.Join(valueLines, "\n")
					}
					// Start new key
					currentKey = line[:idx]
					valueLines = []string{line[idx+1:]}
				} else if currentKey != "" && line != "" {
					// Continuation line - append to current value
					valueLines = append(valueLines, line)
				}
			}
			// Don't forget the last key
			if currentKey != "" {
				env[currentKey] = strings.Join(valueLines, "\n")
			}
		}
	}

	// Read working directory capture
	var pwd string
	pwdData, pwdErr := os.ReadFile(pwdCapturePath)
	if pwdErr != nil {
		// File not existing is expected if script failed early; other errors should be logged
		if !errors.Is(pwdErr, os.ErrNotExist) {
			slog.Warn("Failed to read working directory capture file", "path", pwdCapturePath, "error", pwdErr)
		}
	} else {
		pwd = strings.TrimSpace(string(pwdData))
	}

	if len(env) == 0 {
		return nil, pwd
	}

	return env, pwd
}

// isValidEnvVarName checks if a string is a valid environment variable name.
// Valid names start with a letter or underscore and contain only [A-Za-z0-9_].
// This is used to distinguish new KEY=VALUE pairs from continuation lines in
// multiline values when parsing newline-delimited env output.
func isValidEnvVarName(name string) bool {
	if len(name) == 0 {
		return false
	}
	// First character must be letter or underscore
	first := name[0]
	if !((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') || first == '_') {
		return false
	}
	// Rest must be alphanumeric or underscore
	for i := 1; i < len(name); i++ {
		c := name[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}

// detectInterpreter detects the interpreter from the shebang line or uses provided language
func detectInterpreter(script string, providedLang string) (string, []string) {
	// If language is explicitly provided, use it
	if providedLang != "" {
		return providedLang, []string{}
	}

	// Parse shebang line
	lines := strings.Split(script, "\n")
	if len(lines) > 0 && strings.HasPrefix(lines[0], "#!") {
		shebang := strings.TrimSpace(lines[0][2:]) // Remove #!

		// Handle common patterns
		if strings.Contains(shebang, "/env ") {
			// e.g. #!/usr/bin/env python3 -> ["python3"]
			parts := strings.Fields(shebang)
			if len(parts) >= 2 {
				return parts[1], parts[2:]
			}
		} else {
			// e.g. #!/bin/bash -> ["bash"]
			parts := strings.Fields(shebang)
			if len(parts) >= 1 {
				// Get just the binary name (e.g., "bash" from "/bin/bash")
				interpreter := parts[0]
				if idx := strings.LastIndex(interpreter, "/"); idx != -1 {
					interpreter = interpreter[idx+1:]
				}
				return interpreter, parts[1:]
			}
		}
	}

	// Default to bash
	return "bash", []string{}
}

// isBashInterpreter returns true if the interpreter is bash or sh compatible.
// Only bash-compatible scripts can have their environment changes captured,
// because the environment capture wrapper is written in bash.
func isBashInterpreter(interpreter string) bool {
	switch interpreter {
	case "bash", "sh", "/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh":
		return true
	default:
		return false
	}
}

// streamOutput reads from a pipe and sends lines to the output channel
func streamOutput(pipe io.ReadCloser, outputChan chan<- string) {
	scanner := bufio.NewScanner(pipe)
	for scanner.Scan() {
		outputChan <- scanner.Text()
	}
}

// sendSSELog sends a log event via SSE
func sendSSELog(c *gin.Context, line string) {
	event := ExecLogEvent{
		Line:      line,
		Timestamp: time.Now().Format(time.RFC3339),
	}
	c.SSEvent("log", event)
}

// sendSSEStatus sends a status event via SSE
func sendSSEStatus(c *gin.Context, status string, exitCode int) {
	event := ExecStatusEvent{
		Status:   status,
		ExitCode: exitCode,
	}
	c.SSEvent("status", event)
}

// sendSSEDone sends a done event via SSE
func sendSSEDone(c *gin.Context) {
	c.SSEvent("done", gin.H{})
}

// sendSSEError sends an error event and closes the connection
func sendSSEError(c *gin.Context, message string) {
	c.SSEvent("error", gin.H{"message": message})
	if flusher, ok := c.Writer.(http.Flusher); ok {
		flusher.Flush()
	}
}

// copyFilesFromCaptureDir copies all files from the capture directory (RUNBOOKS_OUTPUT) to the output directory.
// Returns a list of captured files with their relative paths and sizes.
// If the capture directory is empty, returns nil with no error.
func copyFilesFromCaptureDir(captureDir, outputDir string) ([]CapturedFile, error) {
	var capturedFiles []CapturedFile

	// Check if capture directory has any files
	entries, err := os.ReadDir(captureDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read capture directory: %w", err)
	}
	if len(entries) == 0 {
		return nil, nil // No files to capture
	}

	// Create the output directory if it doesn't exist
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create output directory: %w", err)
	}

	// Walk the capture directory and copy all files
	err = filepath.Walk(captureDir, func(srcPath string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		// Skip the root directory itself
		if srcPath == captureDir {
			return nil
		}

		// Get the relative path from the capture directory
		relPath, err := filepath.Rel(captureDir, srcPath)
		if err != nil {
			return fmt.Errorf("failed to get relative path: %w", err)
		}

		// Construct the destination path
		dstPath := filepath.Join(outputDir, relPath)

		if info.IsDir() {
			// Create the directory in the output
			if err := os.MkdirAll(dstPath, info.Mode()); err != nil {
				return err
			}
			return os.Chmod(dstPath, info.Mode())
		}

		// Copy the file
		if err := copyFile(srcPath, dstPath); err != nil {
			return fmt.Errorf("failed to copy file %s: %w", relPath, err)
		}

		capturedFiles = append(capturedFiles, CapturedFile{
			Path: filepath.ToSlash(relPath), // Use forward slashes for consistency
			Size: info.Size(),
		})

		return nil
	})

	if err != nil {
		return nil, err
	}

	return capturedFiles, nil
}

// copyFile copies a single file from src to dst
func copyFile(src, dst string) error {
	// Create parent directories if needed
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	// Open source file
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	// Get source file info for permissions
	srcInfo, err := srcFile.Stat()
	if err != nil {
		return err
	}

	// Create destination file
	dstFile, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, srcInfo.Mode())
	if err != nil {
		return err
	}
	defer dstFile.Close()

	// Copy contents
	_, err = io.Copy(dstFile, srcFile)
	return err
}

// sendSSEFilesCaptured sends a files_captured event via SSE with the list of captured files
// and the updated file tree
func sendSSEFilesCaptured(c *gin.Context, capturedFiles []CapturedFile, cliOutputPath string) {
	// Build the updated file tree from the output directory
	fileTree, err := buildFileTreeWithRoot(cliOutputPath, "")
	if err != nil {
		// Log the error but don't fail - we still captured the files
		slog.Warn("Failed to build file tree for SSE event", "error", err)
		fileTree = nil
	}

	event := FilesCapturedEvent{
		Files:    capturedFiles,
		Count:    len(capturedFiles),
		FileTree: fileTree,
	}
	c.SSEvent("files_captured", event)
}
