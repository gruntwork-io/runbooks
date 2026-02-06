package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"time"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Output Streaming
// =============================================================================

// streamOutput reads from a pipe and sends lines to the output channel
func streamOutput(pipe io.ReadCloser, outputChan chan<- outputLine) {
	scanner := bufio.NewScanner(pipe)
	for scanner.Scan() {
		outputChan <- outputLine{Line: scanner.Text(), Replace: false}
	}
}

// streamExecutionOutput handles the main loop of streaming output and handling completion
// blockInfoForSSE carries block identity for tagging SSE events (provenance).
type blockInfoForSSE struct {
	ComponentID   string
	ComponentType string
}

func streamExecutionOutput(c *gin.Context, flusher http.Flusher, outputChan <-chan outputLine, doneChan <-chan error, ctx context.Context, outputFilePath string, filesDir string, cliOutputPath string, envCapture *envCaptureConfig, block *blockInfoForSSE) {
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
			exitCode, status := DetermineExitStatus(err, ctx)

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
				outputs, parseErr := ParseBlockOutputs(outputFilePath)
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

			// Capture files from GENERATED_FILES directory if execution was successful (or warning)
			// Scripts can write files to $GENERATED_FILES to have them saved to the output directory
			if status == "success" || status == "warn" {
				capturedFiles, captureErr := CaptureFilesFromDir(filesDir, cliOutputPath)
				if captureErr != nil {
					sendSSELog(c, fmt.Sprintf("Warning: Failed to capture files: %v", captureErr))
					flusher.Flush()
				} else if len(capturedFiles) > 0 {
					sendSSEFilesCaptured(c, capturedFiles, cliOutputPath, block)
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

// DetermineExitStatus converts an exec error and context into exit code and status string.
// Exit code 0 = "success", 2 = "warn", anything else = "fail".
// This function is exported for use by the testing package.
func DetermineExitStatus(err error, ctx context.Context) (int, string) {
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
func sendSSEFilesCaptured(c *gin.Context, capturedFiles []CapturedFile, cliOutputPath string, block *blockInfoForSSE) {
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

	// Tag with block provenance if available
	if block != nil {
		event.SourceBlockID = block.ComponentID
		event.SourceBlockType = block.ComponentType
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
