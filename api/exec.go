package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/creack/pty"
	"github.com/gin-gonic/gin"
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
// Types
// =============================================================================

// ExecRequest represents the request to execute a script
type ExecRequest struct {
	ExecutableID      string            `json:"executable_id,omitempty"` // Used when useExecutableRegistry=true
	ComponentID       string            `json:"component_id,omitempty"`  // Used when useExecutableRegistry=false
	TemplateVarValues map[string]any    `json:"template_var_values"`     // Values for template variables (can include nested _blocks)
	EnvVarsOverride   map[string]string `json:"env_vars_override,omitempty"` // Environment variables to set for this execution only (overrides session env)
}

// ExecLogEvent represents a log line event sent via SSE
type ExecLogEvent struct {
	Line      string `json:"line"`
	Timestamp string `json:"timestamp"`
	Replace   bool   `json:"replace,omitempty"` // If true, replace the previous line (for progress updates)
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

// BlockOutputsEvent represents outputs produced by a script via $RUNBOOK_OUTPUT
type BlockOutputsEvent struct {
	Outputs map[string]string `json:"outputs"` // Key-value pairs from the script
}

// execCommandConfig holds configuration for setting up an exec.Cmd
type execCommandConfig struct {
	scriptPath  string
	interpreter string
	args        []string
	execCtx     *SessionExecContext
	envVars     map[string]string // Per-request env var overrides (e.g., AWS credentials for specific auth block)
	outputFile  string            // Temp file for block outputs (RUNBOOK_OUTPUT)
	filesDir    string            // Temp directory for file capture (RUNBOOK_FILES)
}

// envCaptureConfig holds configuration for environment capture after script execution
type envCaptureConfig struct {
	scriptSetup    *ScriptSetup
	sessionManager *SessionManager
	execCtx        *SessionExecContext
}

// =============================================================================
// Main Handler
// =============================================================================

// HandleExecRequest handles the execution of scripts and streams output via SSE.
// This handler must be used with SessionAuthMiddleware to ensure session context is available.
func HandleExecRequest(registry *ExecutableRegistry, runbookPath string, useExecutableRegistry bool, workingDir string, cliOutputPath string, sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req ExecRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		// Get session context (set by SessionAuthMiddleware)
		execCtx := GetSessionExecContext(c)
		if execCtx == nil {
			// This shouldn't happen if middleware is configured correctly
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Session context not found. This is a server configuration error."})
			return
		}

		// Get executable from registry or by parsing runbook
		executable, err := getExecutable(registry, runbookPath, useExecutableRegistry, req)
		if err != nil {
			c.JSON(err.statusCode, gin.H{"error": err.message})
			return
		}

		// Prepare script content (render templates if needed)
		scriptContent, err2 := prepareScriptContent(executable, req.TemplateVarValues)
		if err2 != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err2.Error()})
			return
		}

		// Create a temp directory for file capture (RUNBOOK_FILES)
		// Scripts can write files here to have them captured to the output directory
		filesDir, err2 := os.MkdirTemp("", "runbook-files-*")
		if err2 != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to create files directory: %v", err2)})
			return
		}
		defer os.RemoveAll(filesDir)

		// Create a temp file for block outputs (RUNBOOK_OUTPUT)
		outputFilePath, err2 := createOutputFile()
		if err2 != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err2.Error()})
			return
		}
		defer os.Remove(outputFilePath)

		// Prepare script for execution (handles interpreter detection, env capture wrapping, temp files)
		scriptSetup, err2 := PrepareScriptForExecution(scriptContent, executable.Language)
		if err2 != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err2.Error()})
			return
		}
		defer scriptSetup.Cleanup()

		// Set up SSE headers
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("Transfer-Encoding", "chunked")

		// Create context with 5 minute timeout
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		// Set up command configuration
		cmdConfig := execCommandConfig{
			scriptPath:  scriptSetup.ScriptPath,
			interpreter: scriptSetup.Interpreter,
			args:        scriptSetup.Args,
			execCtx:     execCtx,
			envVars:     req.EnvVarsOverride,
			outputFile:  outputFilePath,
			filesDir:    filesDir,
		}

		// Create channels for streaming output
		outputChan := make(chan outputLine, 100)
		doneChan := make(chan error, 1)

		// Try PTY on Unix systems for better terminal emulation
		// This enables progress bars, colors, and full output from tools like git, npm, docker
		// Falls back to pipes if PTY fails or on Windows
		usedPTY := false
		if ptySupported() {
			// Create command for PTY attempt
			cmd := setupExecCommand(ctx, cmdConfig)

			// Start command with PTY
			ptmx, err2 := startCommandWithPTY(cmd)
			if err2 == nil {
				usedPTY = true

				// Stream PTY output (combined stdout/stderr)
				go streamPTYOutput(ptmx, outputChan)

				// Wait for command to complete
				go func() {
					doneChan <- cmd.Wait()
				}()
			} else {
				// Log PTY failure but continue with fallback
				slog.Warn("PTY execution failed, falling back to pipes", "error", err2)
			}
		}

		// Fallback to pipe-based execution if PTY not supported or failed
		if !usedPTY {
			// Create a fresh command for pipe-based execution
			cmd := setupExecCommand(ctx, cmdConfig)

			stdoutPipe, err2 := cmd.StdoutPipe()
			if err2 != nil {
				sendSSEError(c, fmt.Sprintf("Failed to create stdout pipe: %v", err2))
				return
			}

			stderrPipe, err2 := cmd.StderrPipe()
			if err2 != nil {
				sendSSEError(c, fmt.Sprintf("Failed to create stderr pipe: %v", err2))
				return
			}

			// Start the command
			if err2 := cmd.Start(); err2 != nil {
				sendSSEError(c, fmt.Sprintf("Failed to start script: %v", err2))
				return
			}

			// Stream stdout and stderr
			go streamOutput(stdoutPipe, outputChan)
			go streamOutput(stderrPipe, outputChan)

			// Wait for command to complete
			go func() {
				doneChan <- cmd.Wait()
			}()
		}

		// Flush writer for SSE
		flusher, ok := c.Writer.(http.Flusher)
		if !ok {
			sendSSEError(c, "Streaming not supported")
			return
		}

		// Resolve output path relative to working directory
		resolvedOutputPath := cliOutputPath
		if !filepath.IsAbs(cliOutputPath) {
			resolvedOutputPath = filepath.Join(workingDir, cliOutputPath)
		}

		// Stream logs and wait for completion
		envCaptureConfig := &envCaptureConfig{
			scriptSetup:    scriptSetup,
			sessionManager: sessionManager,
			execCtx:        execCtx,
		}
		streamExecutionOutput(c, flusher, outputChan, doneChan, ctx, outputFilePath, filesDir, resolvedOutputPath, envCaptureConfig)
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

// execError is a helper type for returning HTTP errors from getExecutable
type execError struct {
	statusCode int
	message    string
}

// getExecutable retrieves the executable either from registry or by parsing the runbook
func getExecutable(registry *ExecutableRegistry, runbookPath string, useExecutableRegistry bool, req ExecRequest) (*Executable, *execError) {
	if useExecutableRegistry {
		// Registry mode: Validate against registry
		if req.ExecutableID == "" {
			return nil, &execError{http.StatusBadRequest, "executable_id is required"}
		}

		executable, ok := registry.GetExecutable(req.ExecutableID)
		if !ok {
			return nil, &execError{http.StatusNotFound, "Executable not found in registry"}
		}
		return executable, nil
	}

	// Live reload mode: Parse runbook on-demand
	if req.ComponentID == "" {
		return nil, &execError{http.StatusBadRequest, "component_id is required"}
	}

	executable, err := getExecutableByComponentID(runbookPath, req.ComponentID)
	if err != nil {
		return nil, &execError{http.StatusBadRequest, fmt.Sprintf("Failed to find component: %v", err)}
	}
	return executable, nil
}

// prepareScriptContent renders template variables in the script content if provided
func prepareScriptContent(executable *Executable, templateVars map[string]any) (string, error) {
	scriptContent := executable.ScriptContent

	// If template variable values are provided, render the template
	// This handles both simple {{ .VarName }} patterns and nested paths like {{ ._blocks.xxx.outputs.yyy }}
	if len(templateVars) > 0 {
		rendered, err := RenderBoilerplateContent(scriptContent, templateVars)
		if err != nil {
			return "", fmt.Errorf("failed to render template: %w", err)
		}
		return rendered, nil
	}
	return scriptContent, nil
}

// createOutputFile creates a temporary file for RUNBOOK_OUTPUT
func createOutputFile() (string, error) {
	outputFile, err := os.CreateTemp("", "runbook-output-*.txt")
	if err != nil {
		return "", fmt.Errorf("failed to create output file: %w", err)
	}
	path := outputFile.Name()
	outputFile.Close() // Close so the script can write to it
	return path, nil
}

// createTempScript creates a temporary executable script file
// Returns the path to the script file (caller must clean up)
func createTempScript(content string) (string, error) {
	tmpFile, err := os.CreateTemp("", "runbook-script-*.sh")
	if err != nil {
		return "", fmt.Errorf("failed to create temp file: %w", err)
	}

	if _, err := tmpFile.WriteString(content); err != nil {
		tmpFile.Close()
		os.Remove(tmpFile.Name())
		return "", fmt.Errorf("failed to write script: %w", err)
	}

	if err := os.Chmod(tmpFile.Name(), 0700); err != nil {
		tmpFile.Close()
		os.Remove(tmpFile.Name())
		return "", fmt.Errorf("failed to make script executable: %w", err)
	}
	tmpFile.Close()

	return tmpFile.Name(), nil
}

// setupExecCommand creates and configures an exec.Cmd with the given configuration
func setupExecCommand(ctx context.Context, cfg execCommandConfig) *exec.Cmd {
	cmdArgs := append(cfg.args, cfg.scriptPath)

	// Resolve interpreter to absolute path if it's a well-known shell
	// This is needed for PTY execution which may not have PATH available
	interpreter := resolveInterpreterPath(cfg.interpreter)
	cmd := exec.CommandContext(ctx, interpreter, cmdArgs...)

	// Set environment variables from the session
	cmd.Env = cfg.execCtx.Env

	// Ensure PATH is always available (needed for PTY and for scripts to find tools)
	if !hasEnvVar(cmd.Env, "PATH") {
		// Inherit PATH from the current process
		if path := os.Getenv("PATH"); path != "" {
			cmd.Env = append(cmd.Env, "PATH="+path)
		}
	}

	// Apply per-request env var overrides (e.g., AWS credentials for specific auth block)
	// These override any session env vars with the same key
	if len(cfg.envVars) > 0 {
		cmd.Env = mergeEnvVars(cmd.Env, cfg.envVars)
	}

	// Add RUNBOOK_OUTPUT environment variable for block outputs (key-value pairs)
	cmd.Env = append(cmd.Env, fmt.Sprintf("RUNBOOK_OUTPUT=%s", cfg.outputFile))

	// Add RUNBOOK_FILES environment variable for file capture
	// Scripts can write files to this directory to have them saved to the output directory
	cmd.Env = append(cmd.Env, fmt.Sprintf("RUNBOOK_FILES=%s", cfg.filesDir))

	// Set working directory from session
	if cfg.execCtx.WorkDir != "" {
		cmd.Dir = cfg.execCtx.WorkDir
	}

	return cmd
}

// resolveInterpreterPath attempts to resolve a shell interpreter to its absolute path
// This helps PTY execution which may not have PATH available
func resolveInterpreterPath(interpreter string) string {
	// If already an absolute path, use it directly
	if filepath.IsAbs(interpreter) {
		return interpreter
	}

	// Try to find the interpreter in PATH
	if path, err := exec.LookPath(interpreter); err == nil {
		return path
	}

	// Fall back to the original (let exec handle the error)
	return interpreter
}

// hasEnvVar checks if an environment variable is set in the given env slice
func hasEnvVar(env []string, key string) bool {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return true
		}
	}
	return false
}

// mergeEnvVars merges override env vars into a base env slice.
// Override values replace any existing keys in the base slice.
func mergeEnvVars(base []string, overrides map[string]string) []string {
	// Build a map from existing env for efficient lookup
	envMap := make(map[string]int, len(base)) // key -> index in result
	result := make([]string, 0, len(base)+len(overrides))

	for _, entry := range base {
		if idx := strings.Index(entry, "="); idx != -1 {
			key := entry[:idx]
			envMap[key] = len(result)
			result = append(result, entry)
		}
	}

	// Apply overrides
	for key, value := range overrides {
		entry := key + "=" + value
		if idx, exists := envMap[key]; exists {
			// Replace existing entry
			result[idx] = entry
		} else {
			// Add new entry
			result = append(result, entry)
		}
	}

	return result
}

// determineExitStatus converts an exec error and context into exit code and status string
func determineExitStatus(err error, ctx context.Context) (int, string) {
	if err == nil {
		return 0, "success"
	}

	exitCode := 1
	if exitErr, ok := err.(*exec.ExitError); ok {
		exitCode = exitErr.ExitCode()
	} else if ctx.Err() == context.DeadlineExceeded {
		return -1, "fail"
	}

	// Map exit code to status
	switch exitCode {
	case 0:
		return 0, "success"
	case 2:
		return 2, "warn"
	default:
		return exitCode, "fail"
	}
}

// streamExecutionOutput handles the main loop of streaming output and handling completion
func streamExecutionOutput(c *gin.Context, flusher http.Flusher, outputChan <-chan outputLine, doneChan <-chan error, ctx context.Context, outputFilePath string, filesDir string, cliOutputPath string, envCapture *envCaptureConfig) {
	for {
		select {
		case out := <-outputChan:
			sendSSELogWithReplace(c, out.Line, out.Replace)
			flusher.Flush()

		case err := <-doneChan:
			// Send any remaining logs
			for len(outputChan) > 0 {
				out := <-outputChan
				sendSSELogWithReplace(c, out.Line, out.Replace)
				flusher.Flush()
			}

			// Determine exit code and status
			exitCode, status := determineExitStatus(err, ctx)

			// Log timeout message if applicable
			if ctx.Err() == context.DeadlineExceeded {
				sendSSELog(c, "Script execution timed out after 5 minutes")
				flusher.Flush()
			}

			// Send final status event
			sendSSEStatus(c, status, exitCode)
			flusher.Flush()

			// Parse and send block outputs (if any were written to RUNBOOK_OUTPUT)
			if status == "success" || status == "warn" {
				outputs, parseErr := parseBlockOutputs(outputFilePath)
				if parseErr != nil {
					slog.Warn("Failed to parse block outputs", "error", parseErr)
				} else if len(outputs) > 0 {
					sendSSEOutputs(c, outputs)
					flusher.Flush()
				}
			}

			// Capture environment changes from bash scripts and update session
			if envCapture != nil && (status == "success" || status == "warn") {
				if err := envCapture.scriptSetup.CaptureEnvironmentChanges(envCapture.sessionManager, envCapture.execCtx.WorkDir); err != nil {
					sendSSELog(c, fmt.Sprintf("Warning: could not persist environment changes: %v", err))
					flusher.Flush()
				}
			}

			// Capture files from RUNBOOK_FILES directory if execution was successful (or warning)
			// Scripts can write files to $RUNBOOK_FILES to have them saved to the output directory
			if status == "success" || status == "warn" {
				capturedFiles, captureErr := captureFilesFromDir(filesDir, cliOutputPath)
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

// IsBashInterpreter returns true if the interpreter is a bash-compatible shell.
// Used to determine if environment capture wrapping should be applied.
func IsBashInterpreter(interpreter string) bool {
	switch interpreter {
	case "bash", "sh", "/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh":
		return true
	default:
		return false
	}
}

// createTempFile creates a temporary file and returns its path.
// The file is closed immediately so other processes can write to it.
func createTempFile(pattern string) (string, error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	path := f.Name()
	f.Close()
	return path, nil
}

// ScriptSetup contains the prepared script and related resources for execution.
// Use PrepareScriptForExecution to create this, and call Cleanup when done.
type ScriptSetup struct {
	ScriptPath     string   // Path to the temporary script file
	Interpreter    string   // Interpreter to use (e.g., "bash", "python")
	Args           []string // Additional interpreter arguments
	IsBashScript   bool     // Whether environment capture is enabled
	EnvCapturePath string   // Path to env capture file (only valid if IsBashScript)
	PwdCapturePath string   // Path to pwd capture file (only valid if IsBashScript)
}

// Cleanup removes all temporary files created during script preparation.
func (s *ScriptSetup) Cleanup() {
	if s.ScriptPath != "" {
		os.Remove(s.ScriptPath)
	}
	if s.EnvCapturePath != "" {
		os.Remove(s.EnvCapturePath)
	}
	if s.PwdCapturePath != "" {
		os.Remove(s.PwdCapturePath)
	}
}

// CaptureEnvironmentChanges parses the captured environment after script execution
// and updates the session with any changes. This should only be called after a
// successful (or warning) script execution.
//
// Parameters:
//   - sessionManager: the session manager to update
//   - currentWorkDir: the current working directory (used as fallback if pwd capture fails)
//
// Returns an error only if the session update fails (non-critical, can be ignored).
func (s *ScriptSetup) CaptureEnvironmentChanges(sessionManager *SessionManager, currentWorkDir string) error {
	if !s.IsBashScript {
		return nil // Non-bash scripts don't capture environment
	}

	capturedEnv, capturedPwd := ParseEnvCapture(s.EnvCapturePath, s.PwdCapturePath)
	if capturedEnv == nil {
		return nil // No environment to capture
	}

	// Filter out shell internals
	filteredEnv := FilterCapturedEnv(capturedEnv)

	// Determine new working directory (use captured pwd, or fall back to the original)
	newWorkDir := currentWorkDir
	if capturedPwd != "" {
		newWorkDir = capturedPwd
	}

	// Update session
	return sessionManager.UpdateSessionEnv(filteredEnv, newWorkDir)
}

// PrepareScriptForExecution prepares a script for execution with environment capture.
// It handles:
//   - Detecting the interpreter from shebang or provided language
//   - Creating temp files for environment capture (for bash scripts)
//   - Wrapping bash scripts to capture env changes
//   - Creating the temporary executable script file
//
// Returns a ScriptSetup that must be cleaned up with Cleanup() when done.
func PrepareScriptForExecution(scriptContent string, language string) (*ScriptSetup, error) {
	setup := &ScriptSetup{}

	// Detect interpreter from shebang or use language from executable
	setup.Interpreter, setup.Args = detectInterpreter(scriptContent, language)

	// Check if this is a bash-compatible script
	setup.IsBashScript = IsBashInterpreter(setup.Interpreter)

	// For bash scripts, set up environment capture
	scriptToWrite := scriptContent
	if setup.IsBashScript {
		// Create temp files for environment capture
		var err error
		setup.EnvCapturePath, err = createTempFile("runbook-env-capture-*.txt")
		if err != nil {
			setup.Cleanup()
			return nil, fmt.Errorf("failed to create env capture file: %w", err)
		}

		setup.PwdCapturePath, err = createTempFile("runbook-pwd-capture-*.txt")
		if err != nil {
			setup.Cleanup()
			return nil, fmt.Errorf("failed to create pwd capture file: %w", err)
		}

		// Wrap script for environment capture
		scriptToWrite = WrapScriptForEnvCapture(scriptContent, setup.EnvCapturePath, setup.PwdCapturePath)
	}

	// Create temporary executable script
	var err error
	setup.ScriptPath, err = createTempScript(scriptToWrite)
	if err != nil {
		setup.Cleanup()
		return nil, err
	}

	return setup, nil
}

// WrapScriptForEnvCapture wraps a script to capture environment changes after execution.
// The wrapper appends commands to dump the environment and working directory to temp files.
//
// ## How the wrapper works
//
// The wrapper executes in the same shell context as the user script, allowing environment
// variable changes (export FOO=bar) and directory changes (cd /somewhere) to be captured.
//
// ## Handling user EXIT traps
//
// If the user script sets an EXIT trap (e.g., `trap "cleanup" EXIT`), it would normally
// override our environment capture trap. To handle this, we:
//  1. Define a custom `trap` function that intercepts EXIT trap registrations
//  2. Store the user's EXIT handler in a variable instead of actually setting the trap
//  3. Our combined exit handler runs both: user's handler first, then env capture
//
// This ensures:
//  1. Executes the user's saved handler first (so their cleanup runs)
//  2. Then captures the environment
//  3. Preserves the original exit code
//
// We use `builtin trap` to set our handler, which bypasses our override function.
func WrapScriptForEnvCapture(script, envCapturePath, pwdCapturePath string) string {
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
    # Handle query flags (-p, -l) immediately - pass through to builtin
    # These are for querying trap state, not setting handlers
    if [[ "$1" == "-p" || "$1" == "-l" ]]; then
        builtin trap "$@"
        return $?
    fi

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

// ParseEnvCapture reads the captured environment and working directory from temp files.
// The environment file is expected to be NUL-terminated (from `env -0`) to correctly
// handle environment variable values that contain embedded newlines.
// Falls back to newline-delimited parsing if no NUL characters are found (for compatibility
// with systems where `env -0` might not be available).
func ParseEnvCapture(envCapturePath, pwdCapturePath string) (map[string]string, string) {
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

// streamOutput reads from a pipe and sends lines to the output channel
func streamOutput(pipe io.ReadCloser, outputChan chan<- outputLine) {
	scanner := bufio.NewScanner(pipe)
	for scanner.Scan() {
		outputChan <- outputLine{Line: scanner.Text(), Replace: false}
	}
}

// streamPTYOutput reads from a PTY and sends lines to the output channel.
// PTY output has special characteristics:
// - stdout and stderr are combined into a single stream
// - Progress bars use carriage returns (\r) to overwrite lines
// - Output may contain ANSI escape sequences for colors/formatting
//
// This function handles carriage returns by tracking the "current line" and
// setting the Replace flag when a carriage return triggers an update.
// ANSI codes are stripped.
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
				line := stripANSI(currentLine.String())
				if line != "" {
					outputChan <- outputLine{Line: line, Replace: hadProgressUpdate}
				}
			}
			return
		}

		switch b {
		case '\n':
			// Newline: emit the current line and reset
			line := stripANSI(currentLine.String())
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
				line := stripANSI(currentLine.String())
				if line != "" {
					outputChan <- outputLine{Line: line, Replace: hadProgressUpdate}
				}
				currentLine.Reset()
				hadProgressUpdate = false // Next line starts fresh
			} else {
				// Progress bar style update - emit current line with replace flag
				// This allows progress updates to replace the previous line
				line := stripANSI(currentLine.String())
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

// startCommandWithPTY starts a command in a pseudo-terminal.
// Returns the PTY master file descriptor which should be used for both
// reading output and cleanup (close when done).
// The command will be started as a child process.
func startCommandWithPTY(cmd *exec.Cmd) (*os.File, error) {
	// Start command with PTY
	ptmx, err := pty.StartWithSize(cmd, defaultPTYSize)
	if err != nil {
		return nil, fmt.Errorf("failed to start command with PTY: %w", err)
	}
	return ptmx, nil
}

// captureFilesFromDir copies all files from the source directory (RUNBOOK_FILES) to the output directory.
// Returns a list of captured files with their relative paths and sizes.
// If the source directory is empty, returns nil with no error.
func captureFilesFromDir(srcDir, outputDir string) ([]CapturedFile, error) {
	// Check if source directory has any files
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read files directory: %w", err)
	}
	if len(entries) == 0 {
		return nil, nil // No files to capture
	}

	var capturedFiles []CapturedFile

	// Create the output directory if it doesn't exist
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create output directory: %w", err)
	}

	// Walk the source directory and copy all files
	err = filepath.Walk(srcDir, func(srcPath string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		// Skip the root directory itself
		if srcPath == srcDir {
			return nil
		}

		// Get the relative path from the source directory
		relPath, err := filepath.Rel(srcDir, srcPath)
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
			// Ensure correct permissions are set, as MkdirAll won't update them if the dir exists
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

// parseBlockOutputs reads the RUNBOOK_OUTPUT file and parses key=value pairs
// Format: one key=value per line, keys must match ^[a-zA-Z_][a-zA-Z0-9_]*$
// Returns a map of outputs, or empty map if file is empty/missing
func parseBlockOutputs(filePath string) (map[string]string, error) {
	outputs := make(map[string]string)

	// Read the file
	content, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			// File doesn't exist - script didn't write any outputs
			return outputs, nil
		}
		return nil, fmt.Errorf("failed to read output file: %w", err)
	}

	// Parse line by line
	lines := strings.Split(string(content), "\n")
	for lineNum, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// Find the first = sign
		eqIdx := strings.Index(line, "=")
		if eqIdx == -1 {
			slog.Warn("Invalid output line (no = sign)", "line", lineNum+1, "content", line)
			continue
		}

		key := strings.TrimSpace(line[:eqIdx])
		value := line[eqIdx+1:] // Don't trim value - preserve whitespace

		// Validate key format
		if !isValidOutputKey(key) {
			slog.Warn("Invalid output key", "line", lineNum+1, "key", key)
			continue
		}

		outputs[key] = value
	}

	return outputs, nil
}

// isValidOutputKey checks if a key matches ^[a-zA-Z_][a-zA-Z0-9_]*$
func isValidOutputKey(key string) bool {
	if len(key) == 0 {
		return false
	}

	// First character must be letter or underscore
	first := key[0]
	if !((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first == '_') {
		return false
	}

	// Rest must be alphanumeric or underscore
	for i := 1; i < len(key); i++ {
		c := key[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}

	return true
}

// =============================================================================
// SSE Event Helpers
// =============================================================================

// sendSSELog sends a log event via SSE
func sendSSELog(c *gin.Context, line string) {
	sendSSELogWithReplace(c, line, false)
}

// sendSSELogWithReplace sends a log event via SSE with optional replace flag
// When replace is true, the frontend should replace the previous line instead of appending
func sendSSELogWithReplace(c *gin.Context, line string, replace bool) {
	event := ExecLogEvent{
		Line:      line,
		Timestamp: time.Now().Format(time.RFC3339),
		Replace:   replace,
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

// sendSSEOutputs sends an outputs event via SSE with the parsed outputs
func sendSSEOutputs(c *gin.Context, outputs map[string]string) {
	event := BlockOutputsEvent{
		Outputs: outputs,
	}
	jsonBytes, err := json.Marshal(event)
	if err != nil {
		slog.Error("Failed to marshal outputs event", "error", err)
		return
	}
	// Write SSE event manually to match gin's format (no spaces after colons)
	c.Writer.WriteString(fmt.Sprintf("event:outputs\ndata:%s\n\n", string(jsonBytes)))
}
