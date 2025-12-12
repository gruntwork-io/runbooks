package api

import (
	"bufio"
	"context"
	"fmt"
	"io"
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
	ExecutableID           string            `json:"executable_id,omitempty"`             // Used when useExecutableRegistry=true
	ComponentID            string            `json:"component_id,omitempty"`              // Used when useExecutableRegistry=false
	TemplateVarValues      map[string]string `json:"template_var_values"`                 // Values for template variables
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

// HandleExecRequest handles the execution of scripts and streams output via SSE
func HandleExecRequest(registry *ExecutableRegistry, runbookPath string, useExecutableRegistry bool, cliOutputPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req ExecRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
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

		// Validate captureFilesOutputPath if captureFiles is enabled
		var captureOutputDir string
		if req.CaptureFiles {
			// Validate the output path (reuse validation from boilerplate_render.go)
			if err := validateOutputPath(req.CaptureFilesOutputPath); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid captureFilesOutputPath: %v", err)})
				return
			}

			// Determine the output directory for captured files
			captureOutputDir, err = determineOutputDirectory(cliOutputPath, &req.CaptureFilesOutputPath)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Failed to determine capture output directory: %v", err)})
				return
			}
		}

		// Create an isolated working directory for the script when captureFiles is enabled
		// This ensures all relative file writes are captured
		var workDir string
		if req.CaptureFiles {
			workDir, err = os.MkdirTemp("", "runbook-cmd-workspace-*")
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to create working directory: %v", err)})
				return
			}
			defer os.RemoveAll(workDir) // Clean up the working directory when done
		}

		// Set up SSE headers
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("Transfer-Encoding", "chunked")

		// Create a temporary file for the script
		tmpFile, err := os.CreateTemp("", "runbook-check-*.sh")
		if err != nil {
			sendSSEError(c, fmt.Sprintf("Failed to create temp file: %v", err))
			return
		}
		defer os.Remove(tmpFile.Name())

		// Write script content to temp file
		if _, err := tmpFile.WriteString(scriptContent); err != nil {
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

		// Detect interpreter from shebang or use language from executable
		interpreter, args := detectInterpreter(scriptContent, executable.Language)

		// Create context with 5 minute timeout
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		// Prepare command
		cmdArgs := append(args, tmpFile.Name())
		cmd := exec.CommandContext(ctx, interpreter, cmdArgs...)

		// Pass through all environment variables
		// This feels dirty, but the point of a Runbook is to streamline what a user would otherwise do
		// in their local environment! For users who want more security/control here, a commercial version
		// of Runbooks is probably the answer.
		cmd.Env = os.Environ()

		// Set working directory if capturing files
		// This isolates the script so all relative file writes are captured
		if req.CaptureFiles && workDir != "" {
			cmd.Dir = workDir
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

				// Capture files if enabled and execution was successful (or warning)
				if req.CaptureFiles && workDir != "" && (status == "success" || status == "warn") {
					capturedFiles, captureErr := captureFilesFromWorkDir(workDir, captureOutputDir, cliOutputPath)
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
			return os.MkdirAll(dstPath, info.Mode())
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

// sendSSEFilesCaptured sends a files_captured event via SSE with the list of captured files
// and the updated file tree
func sendSSEFilesCaptured(c *gin.Context, capturedFiles []CapturedFile, cliOutputPath string) {
	// Build the updated file tree from the output directory
	fileTree, err := buildFileTreeWithRoot(cliOutputPath, "")
	if err != nil {
		// Log the error but don't fail - we still captured the files
		fileTree = nil
	}

	event := FilesCapturedEvent{
		Files:    capturedFiles,
		Count:    len(capturedFiles),
		FileTree: fileTree,
	}
	c.SSEvent("files_captured", event)
}
