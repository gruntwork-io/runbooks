package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// ExecEventSink abstracts the transport for exec streaming output. The
// Gin handler (legacy) sends Server-Sent Events; the M4 IPC ExecService
// emits topic-scoped Wails events. Keeping the core streamer agnostic
// of both lets the executor logic in exec_stream.go stay the same.
//
// Methods mirror the six SSE events the frontend already consumes:
// "log", "status", "outputs", "files_captured", "error", "done". The
// sink is closed/cleaned up by the caller (Gin relies on HTTP lifecycle;
// the emitter sink is stateless).
type ExecEventSink interface {
	Log(line string, replace bool)
	Status(status string, exitCode int)
	Outputs(outputs map[string]string)
	FilesCaptured(event FilesCapturedEvent)
	Error(message string)
	Done()
}

// GinSSEEventSink writes events to a Gin context as SSE frames and
// flushes after every send (so the browser sees each event in real
// time rather than waiting for buffering). Used by the legacy
// /api/exec HTTP endpoint.
type GinSSEEventSink struct {
	c       *gin.Context
	flusher http.Flusher
}

func NewGinSSEEventSink(c *gin.Context, flusher http.Flusher) *GinSSEEventSink {
	return &GinSSEEventSink{c: c, flusher: flusher}
}

func (s *GinSSEEventSink) Log(line string, replace bool) {
	s.c.SSEvent("log", ExecLogEvent{
		Line:      line,
		Timestamp: time.Now().Format(time.RFC3339),
		Replace:   replace,
	})
	s.flusher.Flush()
}

func (s *GinSSEEventSink) Status(status string, exitCode int) {
	s.c.SSEvent("status", ExecStatusEvent{Status: status, ExitCode: exitCode})
	s.flusher.Flush()
}

func (s *GinSSEEventSink) Outputs(outputs map[string]string) {
	// Match gin's SSE format but write manually — BlockOutputsEvent
	// payloads used to skip gin's encoder to avoid extra whitespace.
	event := BlockOutputsEvent{Outputs: outputs}
	jsonBytes, err := json.Marshal(event)
	if err != nil {
		slog.Error("Failed to marshal outputs event", "error", err)
		return
	}
	s.c.Writer.WriteString(fmt.Sprintf("event:outputs\ndata:%s\n\n", string(jsonBytes)))
	s.flusher.Flush()
}

func (s *GinSSEEventSink) FilesCaptured(event FilesCapturedEvent) {
	s.c.SSEvent("files_captured", event)
	s.flusher.Flush()
}

func (s *GinSSEEventSink) Error(message string) {
	s.c.SSEvent("error", gin.H{"message": message})
	s.flusher.Flush()
}

func (s *GinSSEEventSink) Done() {
	s.c.SSEvent("done", gin.H{})
	s.flusher.Flush()
}
