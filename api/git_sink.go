package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// GitEventSink abstracts the transport for git-operation streaming
// (clone, push, pull-request). Today's Gin handlers send SSE frames
// directly; the M4 IPC GitService emits topic-scoped Wails events.
// Keeping the core streamers agnostic of both lets the same code drive
// both transports.
//
// Event shapes mirror the SSE format the frontend already consumes:
//   - Log: line + replace flag (replace lets PTY progress bars overwrite
//     the previous line)
//   - Status: "success" / "warn" / "fail" + exit code
//   - Outputs: block outputs that feed into GruntbookContext
//   - Event: named structured events (clone_result, pr_result, error)
//   - Done: end-of-stream marker
//
// FailStatus + Fail are convenience wrappers for the common
// "log error, mark failed, close stream" pattern.
type GitEventSink interface {
	Log(line string, replace bool)
	Status(status string, exitCode int)
	Outputs(outputs map[string]string)
	Event(name string, data any)
	Done()
}

// FailGit is the shared implementation of "log an error, mark fail, end
// stream" for any GitEventSink.
func FailGit(sink GitEventSink, msg string) {
	sink.Log(msg, false)
	sink.Status("fail", 1)
	sink.Done()
}

// GinSSEGitSink writes GitEventSink events as SSE frames on a Gin
// response writer and flushes after each one. Used by the legacy
// /api/git/* HTTP endpoints while they remain in place alongside the
// IPC GitService.
type GinSSEGitSink struct {
	c       *gin.Context
	flusher http.Flusher
}

// NewGinSSEGitSink constructs a sink from a Gin context. The caller
// must have already set the text/event-stream headers and obtained a
// flusher (returning 500 if streaming is unsupported).
func NewGinSSEGitSink(c *gin.Context, flusher http.Flusher) *GinSSEGitSink {
	return &GinSSEGitSink{c: c, flusher: flusher}
}

func (s *GinSSEGitSink) Log(line string, replace bool) {
	sendSSELogWithReplace(s.c, line, replace)
	s.flusher.Flush()
}

func (s *GinSSEGitSink) Status(status string, exitCode int) {
	sendSSEStatus(s.c, status, exitCode)
	s.flusher.Flush()
}

func (s *GinSSEGitSink) Outputs(outputs map[string]string) {
	sendSSEOutputs(s.c, outputs)
	s.flusher.Flush()
}

func (s *GinSSEGitSink) Event(name string, data any) {
	// Gin's SSEvent encodes a JSON body for struct data. Mirror the
	// shape used by the existing handlers so the frontend parses
	// clone_result / pr_result / error identically.
	s.c.SSEvent(name, data)
	s.flusher.Flush()
}

func (s *GinSSEGitSink) Done() {
	sendSSEDone(s.c)
	s.flusher.Flush()
}

// EmitterGitSink emits GitEventSink events as topic-scoped Wails
// events under the prefix `git:<runID>:<event>`. The frontend subscribes
// to these after receiving runID from the IPC call. JSON-encoded event
// payloads match the SSE-event shape exactly so the same Zod schemas
// on the frontend work for both transports.
type EmitterGitSink struct {
	emitter gitEmitter
	runID   string
}

// gitEmitter is the subset of ports.Emitter that EmitterGitSink needs.
// Declared locally so api/ can stay free of ports/ imports; the IPC
// service adapts ports.Emitter to this by sharing the single Emit method.
type gitEmitter interface {
	Emit(topic string, payload any) error
}

// NewEmitterGitSink builds a sink that emits under `git:<runID>:*`.
func NewEmitterGitSink(emitter gitEmitter, runID string) *EmitterGitSink {
	return &EmitterGitSink{emitter: emitter, runID: runID}
}

func (s *EmitterGitSink) topic(event string) string {
	return fmt.Sprintf("git:%s:%s", s.runID, event)
}

func (s *EmitterGitSink) emit(event string, payload any) {
	if err := s.emitter.Emit(s.topic(event), payload); err != nil {
		slog.Warn("git sink emit failed", "event", event, "runID", s.runID, "error", err)
	}
}

func (s *EmitterGitSink) Log(line string, replace bool) {
	s.emit("log", ExecLogEvent{
		Line:      line,
		Timestamp: time.Now().Format(time.RFC3339),
		Replace:   replace,
	})
}

func (s *EmitterGitSink) Status(status string, exitCode int) {
	s.emit("status", ExecStatusEvent{Status: status, ExitCode: exitCode})
}

func (s *EmitterGitSink) Outputs(outputs map[string]string) {
	s.emit("outputs", BlockOutputsEvent{Outputs: outputs})
}

func (s *EmitterGitSink) Event(name string, data any) {
	// Round-trip through JSON so emitted payloads look exactly like
	// SSE-encoded data: field tags respected, pointers dereferenced,
	// nothing platform-specific. The frontend's Zod schemas expect the
	// flat struct shape, not Wails' reflected struct.
	raw, err := json.Marshal(data)
	if err != nil {
		slog.Warn("git sink event marshal failed", "name", name, "runID", s.runID, "error", err)
		return
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		slog.Warn("git sink event unmarshal failed", "name", name, "runID", s.runID, "error", err)
		return
	}
	s.emit(name, out)
}

func (s *EmitterGitSink) Done() {
	s.emit("done", struct{}{})
}
