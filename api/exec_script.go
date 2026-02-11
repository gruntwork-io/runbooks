package api

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// =============================================================================
// Script Preparation and Environment Capture
// =============================================================================

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

// =============================================================================
// Interpreter Detection
// =============================================================================

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

// =============================================================================
// Temp File Helpers
// =============================================================================

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

// =============================================================================
// Environment Capture Wrapper
// =============================================================================

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

// =============================================================================
// Environment Capture Parsing
// =============================================================================

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

// =============================================================================
// File Capture
// =============================================================================

// CaptureFilesFromDir copies all files from the source directory (GENERATED_FILES) to the output directory.
// Returns a list of captured files with their relative paths and sizes.
// If the source directory is empty, returns nil with no error.
// This function is exported for use by the testing package.
func CaptureFilesFromDir(srcDir, outputDir string) ([]CapturedFile, error) {
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
		if err := CopyFile(srcPath, dstPath); err != nil {
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

// CopyFile copies a single file from src to dst, preserving permissions.
// This function is exported for use by the testing package.
func CopyFile(src, dst string) error {
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

// =============================================================================
// Block Output Parsing
// =============================================================================

// ParseBlockOutputs reads the RUNBOOK_OUTPUT file and parses key=value pairs.
// Format: one key=value per line, keys must match ^[a-zA-Z_][a-zA-Z0-9_]*$
// Returns a map of outputs, or empty map if file is empty/missing.
// This function is exported for use by the testing package.
func ParseBlockOutputs(filePath string) (map[string]string, error) {
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
