package api

import (
	"bufio"
	"context"
	"encoding/json"
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

// =============================================================================
// Types
// =============================================================================

// ExecRequest represents the request to execute a script
type ExecRequest struct {
	ExecutableID           string            `json:"executable_id,omitempty"`             // Used when useExecutableRegistry=true
	ComponentID            string            `json:"component_id,omitempty"`              // Used when useExecutableRegistry=false
	TemplateVarValues      map[string]any    `json:"template_var_values"`                 // Values for template variables (can include nested _blocks)
	EnvVars                map[string]string `json:"env_vars,omitempty"`                  // Environment variables to set for this execution only (overrides session env)
	CaptureFiles           bool              `json:"capture_files"`                       // When true, capture files written by the script to the workspace
	CaptureFilesOutputPath string            `json:"capture_files_output_path,omitempty"` // Relative subdirectory within the output folder for captured files
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
	captureFiles bool
	workDir      string
	outputFile   string
}

// captureFilesConfig holds configuration for file capture setup
type captureFilesConfig struct {
	outputDir string
	workDir   string
}

// =============================================================================
// Main Handler
// =============================================================================

// HandleExecRequest handles the execution of scripts and streams output via SSE.
// This handler must be used with SessionAuthMiddleware to ensure session context is available.
func HandleExecRequest(registry *ExecutableRegistry, runbookPath string, useExecutableRegistry bool, cliOutputPath string) gin.HandlerFunc {
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

		// Set up capture files configuration if enabled
		var captureConfig *captureFilesConfig
		if req.CaptureFiles {
			captureConfig, err2 = setupCaptureFiles(req.CaptureFilesOutputPath, cliOutputPath)
			if err2 != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err2.Error()})
				return
			}
			defer func() {
				if captureConfig.workDir != "" {
					os.RemoveAll(captureConfig.workDir)
				}
			}()
		}

		// Create a temp file for block outputs (RUNBOOK_OUTPUT)
		outputFilePath, err2 := createOutputFile()
		if err2 != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err2.Error()})
			return
		}
		defer os.Remove(outputFilePath)

		// Set up SSE headers
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("Transfer-Encoding", "chunked")

		// Create temporary executable script
		scriptPath, err2 := createTempScript(scriptContent)
		if err2 != nil {
			sendSSEError(c, err2.Error())
			return
		}
		defer os.Remove(scriptPath)

		// Detect interpreter from shebang or use language from executable
		interpreter, args := detectInterpreter(scriptContent, executable.Language)

		// Create context with 5 minute timeout
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		// Set up command configuration
		cmdConfig := execCommandConfig{
			scriptPath:  scriptPath,
			interpreter: interpreter,
			args:        args,
			execCtx:     execCtx,
			envVars:     req.EnvVars,
			outputFile:  outputFilePath,
		}
		if captureConfig != nil {
			cmdConfig.captureFiles = true
			cmdConfig.workDir = captureConfig.workDir
		}

		// Create and configure the command
		cmd := setupExecCommand(ctx, cmdConfig)

		// Get stdout and stderr pipes
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

		// Create channels for streaming output
		outputChan := make(chan string, 100)
		doneChan := make(chan error, 1)

		// Stream stdout and stderr
		go streamOutput(stdoutPipe, outputChan)
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
		streamExecutionOutput(c, flusher, outputChan, doneChan, ctx, outputFilePath, captureConfig, cliOutputPath)
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
		rendered, err := renderBoilerplateContent(scriptContent, templateVars)
		if err != nil {
			return "", fmt.Errorf("failed to render template: %w", err)
		}
		return rendered, nil
	}
	return scriptContent, nil
}

// setupCaptureFiles validates and creates the capture files configuration
func setupCaptureFiles(captureFilesOutputPath string, cliOutputPath string) (*captureFilesConfig, error) {
	// Validate the output path
	if err := ValidateRelativePath(captureFilesOutputPath); err != nil {
		return nil, fmt.Errorf("invalid captureFilesOutputPath: %w", err)
	}

	// Determine the output directory for captured files
	outputDir, err := determineOutputDirectory(cliOutputPath, &captureFilesOutputPath)
	if err != nil {
		return nil, fmt.Errorf("failed to determine capture output directory: %w", err)
	}

	// Create an isolated working directory for the script
	// This ensures all relative file writes are captured
	workDir, err := os.MkdirTemp("", "runbook-cmd-workspace-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create working directory: %w", err)
	}

	return &captureFilesConfig{
		outputDir: outputDir,
		workDir:   workDir,
	}, nil
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
	cmd := exec.CommandContext(ctx, cfg.interpreter, cmdArgs...)

	// Set environment variables from the session
	cmd.Env = cfg.execCtx.Env

	// Apply per-request env var overrides (e.g., AWS credentials for specific auth block)
	// These override any session env vars with the same key
	if len(cfg.envVars) > 0 {
		cmd.Env = mergeEnvVars(cmd.Env, cfg.envVars)
	}

	// Add RUNBOOK_OUTPUT environment variable for block outputs
	cmd.Env = append(cmd.Env, fmt.Sprintf("RUNBOOK_OUTPUT=%s", cfg.outputFile))

	// Set working directory from session
	if cfg.execCtx.WorkDir != "" {
		cmd.Dir = cfg.execCtx.WorkDir
	}

	// Override with captureFiles working directory if enabled
	// This isolates the script so all relative file writes are captured
	if cfg.captureFiles && cfg.workDir != "" {
		cmd.Dir = cfg.workDir
	}

	return cmd
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
func streamExecutionOutput(c *gin.Context, flusher http.Flusher, outputChan <-chan string, doneChan <-chan error, ctx context.Context, outputFilePath string, captureConfig *captureFilesConfig, cliOutputPath string) {
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

			// Capture files if enabled and execution was successful (or warning)
			if captureConfig != nil && (status == "success" || status == "warn") {
				capturedFiles, captureErr := captureFilesFromWorkDir(captureConfig.workDir, captureConfig.outputDir, cliOutputPath)
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

// streamOutput reads from a pipe and sends lines to the output channel
func streamOutput(pipe io.ReadCloser, outputChan chan<- string) {
	scanner := bufio.NewScanner(pipe)
	for scanner.Scan() {
		outputChan <- scanner.Text()
	}
}

// captureFilesFromWorkDir copies all files from the working directory to the output directory
// Returns a list of captured files with their relative paths and sizes
func captureFilesFromWorkDir(workDir, captureOutputDir, cliOutputPath string) ([]CapturedFile, error) {
	var capturedFiles []CapturedFile

	// Create the output directory if it doesn't exist
	if err := os.MkdirAll(captureOutputDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create output directory: %w", err)
	}

	// Walk the working directory and copy all files
	err := filepath.Walk(workDir, func(srcPath string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		// Skip the root directory itself
		if srcPath == workDir {
			return nil
		}

		// Get the relative path from the working directory
		relPath, err := filepath.Rel(workDir, srcPath)
		if err != nil {
			return fmt.Errorf("failed to get relative path: %w", err)
		}

		// Construct the destination path
		dstPath := filepath.Join(captureOutputDir, relPath)

		if info.IsDir() {
			// Create the directory in the output
			if err := os.MkdirAll(dstPath, info.Mode()); err != nil {
				return err
			}
			// Ensure correct permissions are set, as MkdirAll won't update them if the dir exists
			// (can happen due to filepath.Walk's lexical order - a file inside may be processed first)
			return os.Chmod(dstPath, info.Mode())
		}

		// Copy the file
		if err := copyFile(srcPath, dstPath); err != nil {
			return fmt.Errorf("failed to copy file %s: %w", relPath, err)
		}

		// Calculate relative path from CLI output path for the response
		// This is what the frontend expects to see in the file tree
		outputRelPath := relPath
		if captureOutputDir != cliOutputPath {
			// If we're in a subdirectory, include that in the relative path
			subDir, _ := filepath.Rel(cliOutputPath, captureOutputDir)
			if subDir != "" && subDir != "." {
				outputRelPath = filepath.Join(subDir, relPath)
			}
		}

		capturedFiles = append(capturedFiles, CapturedFile{
			Path: filepath.ToSlash(outputRelPath), // Use forward slashes for consistency
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
