package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Types
// =============================================================================

// ExecRequest represents the request to execute a script
type ExecRequest struct {
	ExecutableID      string            `json:"executable_id,omitempty"`     // Used when useExecutableRegistry=true
	ComponentID       string            `json:"component_id,omitempty"`      // Used when useExecutableRegistry=false
	TemplateVarValues map[string]any    `json:"template_var_values"`         // Values for template variables (includes inputs and outputs namespaces)
	EnvVarsOverride   map[string]string `json:"env_vars_override,omitempty"` // Environment variables to set for this execution only (overrides session env)
	UsePTY            *bool             `json:"use_pty,omitempty"`           // Whether to use PTY for execution (default: true). Set to false to use pipes instead.
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
	scriptPath   string
	interpreter  string
	args         []string
	execCtx      *SessionExecContext
	envVars      map[string]string // Per-request env var overrides (e.g., AWS credentials for specific auth block)
	outputFile   string            // Temp file for block outputs (RUNBOOK_OUTPUT)
	filesDir     string            // Temp directory for file capture (GENERATED_FILES)
	workTreePath string            // Active git worktree path for REPO_FILES (empty if none)
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
func HandleExecRequest(registry *ExecutableRegistry, gruntbookPath string, useExecutableRegistry bool, workingDir string, cliOutputPath string, sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req ExecRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		execCtx := GetSessionExecContext(c)
		if execCtx == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Session context not found. This is a server configuration error."})
			return
		}

		runCfg := ExecRunConfig{
			Registry:      registry,
			GruntbookPath: gruntbookPath,
			UseRegistry:   useExecutableRegistry,
			WorkingDir:    workingDir,
			CliOutputPath: cliOutputPath,
			Sessions:      sessionManager,
			ExecCtx:       execCtx,
		}

		res, cmdConfig, err := RunExecPrepare(req, runCfg)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		defer res.Cleanup()

		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")

		flusher, ok := c.Writer.(http.Flusher)
		if !ok {
			sendSSEError(c, "Streaming not supported")
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		sink := NewGinSSEEventSink(c, flusher)
		RunExecStream(ctx, req, runCfg, res, cmdConfig, sink)
	}
}

// =============================================================================
// Executable Lookup
// =============================================================================

// execError is a helper type for returning HTTP errors from getExecutable
type execError struct {
	statusCode int
	message    string
}

// getExecutable retrieves the executable either from registry or by parsing the gruntbook
func getExecutable(registry *ExecutableRegistry, gruntbookPath string, useExecutableRegistry bool, req ExecRequest) (*Executable, *execError) {
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

	// Live reload mode: Parse gruntbook on-demand
	if req.ComponentID == "" {
		return nil, &execError{http.StatusBadRequest, "component_id is required"}
	}

	executable, err := getExecutableByComponentID(gruntbookPath, req.ComponentID)
	if err != nil {
		return nil, &execError{http.StatusBadRequest, fmt.Sprintf("Failed to find component: %v", err)}
	}
	return executable, nil
}

// prepareScriptContent renders template variables in the script content if provided
func prepareScriptContent(executable *Executable, templateVars map[string]any) (string, error) {
	scriptContent := executable.ScriptContent

	// If template variable values are provided, render the template
	// This handles both {{ .inputs.VarName }} patterns and output paths like {{ .outputs.blockId.outputName }}
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
	outputFile, err := os.CreateTemp("", "gruntbook-output-*.txt")
	if err != nil {
		return "", fmt.Errorf("failed to create output file: %w", err)
	}
	path := outputFile.Name()
	outputFile.Close() // Close so the script can write to it
	return path, nil
}

// =============================================================================
// Command Setup and Execution
// =============================================================================

// SetupExecEnvVars appends the standard gruntbook-managed environment variables to the
// given environment slice. This is the single source of truth for which env vars are
// injected into script execution, used by both the runtime server and the testing
// framework. It sets:
//   - GRUNTBOOK_OUTPUT: path to the block outputs file (key-value pairs)
//   - RUNBOOK_OUTPUT: legacy alias of GRUNTBOOK_OUTPUT, retained for backward compatibility
//   - GENERATED_FILES: path to the file capture directory
//   - REPO_FILES: path to the active git worktree (if one is registered)
func SetupExecEnvVars(env []string, outputFile, filesDir, workTreePath string) []string {
	// GRUNTBOOK_OUTPUT is the canonical env var for block outputs (key-value pairs).
	// RUNBOOK_OUTPUT is kept as a legacy alias so existing gruntbook scripts continue to work.
	env = append(env, fmt.Sprintf("GRUNTBOOK_OUTPUT=%s", outputFile))
	env = append(env, fmt.Sprintf("RUNBOOK_OUTPUT=%s", outputFile))

	// Add GENERATED_FILES environment variable for file capture
	// Scripts can write files to this directory to have them saved to the output directory
	env = append(env, fmt.Sprintf("GENERATED_FILES=%s", filesDir))

	// Add REPO_FILES environment variable if a git worktree has been registered
	if workTreePath != "" {
		env = append(env, fmt.Sprintf("REPO_FILES=%s", workTreePath))
	}

	return env
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
		cmd.Env = MergeEnvVars(cmd.Env, cfg.envVars)
	}

	// Use shared helper for standard execution env vars
	cmd.Env = SetupExecEnvVars(cmd.Env, cfg.outputFile, cfg.filesDir, cfg.workTreePath)

	// Set working directory from session
	if cfg.execCtx.WorkDir != "" {
		cmd.Dir = cfg.execCtx.WorkDir
	}

	return cmd
}

// startCommandExecution starts the command using either PTY or pipes for output streaming.
// It prefers PTY on supported systems for better terminal emulation (progress bars, colors, etc.)
// and falls back to pipes if PTY fails or is not supported.
// Returns an error if the command couldn't be started.
func startCommandExecution(ctx context.Context, cmdConfig execCommandConfig, usePTY bool, outputChan chan<- outputLine, doneChan chan<- error) error {
	// Try PTY first if requested and supported
	// PTY enables progress bars, colors, and full output from tools like git, npm, docker
	if usePTY && ptySupported() {
		cmd := setupExecCommand(ctx, cmdConfig)
		ptmx, err := startCommandWithPTY(cmd)
		if err == nil {
			// PTY started successfully - stream output and wait for completion
			go streamPTYOutput(ptmx, outputChan)
			go func() {
				doneChan <- cmd.Wait()
			}()
			return nil
		}
		// Log PTY failure but continue with fallback
		slog.Warn("PTY execution failed, falling back to pipes", "error", err)
	}

	// Fallback to pipe-based execution (used when PTY not supported or failed)
	cmd := setupExecCommand(ctx, cmdConfig)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start script: %w", err)
	}

	// Stream stdout and stderr
	go streamOutput(stdoutPipe, outputChan)
	go streamOutput(stderrPipe, outputChan)

	// Wait for command to complete
	go func() {
		doneChan <- cmd.Wait()
	}()

	return nil
}

// =============================================================================
// Command Helpers
// =============================================================================

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

// MergeEnvVars merges override env vars into a base env slice.
// Override values replace any existing keys in the base slice.
// This is important for proper credential isolation - when using awsAuthId to reference
// an auth block with different credentials, we need to fully replace the old credentials,
// including explicitly setting AWS_SESSION_TOKEN="" if the new credentials don't have one.
func MergeEnvVars(base []string, overrides map[string]string) []string {
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

