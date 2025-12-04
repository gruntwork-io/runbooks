package api

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ExecRequest represents the request to execute a script
type ExecRequest struct {
	ExecutableID      string            `json:"executable_id,omitempty"`      // Used when useExecutableRegistry=true
	ComponentID       string            `json:"component_id,omitempty"`       // Used when useExecutableRegistry=false
	TemplateVarValues map[string]string `json:"template_var_values"` // Values for template variables
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

// HandleExecRequest handles the execution of scripts and streams output via SSE
func HandleExecRequest(registry *ExecutableRegistry, runbookPath string, useExecutableRegistry bool) gin.HandlerFunc {
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
