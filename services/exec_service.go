package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/gruntwork-io/runbooks/api"
	"github.com/gruntwork-io/runbooks/core/ports"
)

// ExecService is the Wails IPC wrapper around the api.RunExec* helpers.
//
// Today's HTTP /api/exec endpoint streams output via Server-Sent Events
// on the same connection. The IPC version inverts that: Run returns a
// runID immediately and pushes events through the Wails emitter under
// topic-scoped channels (`exec:<runID>:log`, `exec:<runID>:status`,
// `exec:<runID>:outputs`, `exec:<runID>:files_captured`,
// `exec:<runID>:error`, `exec:<runID>:done`). The frontend subscribes
// with Events.On(topic, cb) keyed off the runID. This also makes
// Cancel(runID) natural — something that was awkward over SSE.
//
// Setup errors (invalid session, missing executable, template render
// failure, temp-dir creation) surface synchronously as Run's error
// return. Execution-time issues (non-zero exit, timeout) arrive
// through the event channels, matching the legacy SSE shape.
type ExecService struct {
	servers *serverManager
	emitter ports.Emitter

	mu   sync.Mutex
	runs map[string]context.CancelFunc
}

func NewExecService(servers *serverManager, emitter ports.Emitter) *ExecService {
	return &ExecService{
		servers: servers,
		emitter: emitter,
		runs:    make(map[string]context.CancelFunc),
	}
}

func (s *ExecService) ServiceName() string { return "ExecService" }

// ExecRunResult is the return value of Run: the runID the frontend
// subscribes to, plus a timestamp the UI uses to align "starting"
// placeholder logs with the upcoming log event stream.
type ExecRunResult struct {
	RunID     string `json:"runId"`
	StartedAt string `json:"startedAt"`
}

// Run starts an exec run asynchronously. Validates the session and
// prepares all temp resources synchronously (so authoring/setup errors
// are returned as errors, not event-stream errors), then launches a
// goroutine that streams output under `exec:<runID>:*` topics.
//
// SessionID is the same Bearer token the HTTP client uses — M4 reuses
// the SessionManager from the embedded Gin server so the two
// transports see the same session state (env vars, worktree, exec
// count). Leave it empty during bootstrapping (before a session
// exists); Run will reject with a clear error.
func (s *ExecService) Run(sessionID string, req api.ExecRequest) (*ExecRunResult, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	execCtx, ok := sessions.ValidateToken(sessionID)
	if !ok {
		return nil, fmt.Errorf("invalid or missing session token")
	}

	cfg := s.servers.Config()
	registry, err := s.servers.Registry()
	if err != nil {
		return nil, err
	}

	runCfg := api.ExecRunConfig{
		Registry:      registry,
		GruntbookPath: cfg.GruntbookPath,
		UseRegistry:   cfg.UseExecutableRegistry,
		WorkingDir:    cfg.WorkingDir,
		CliOutputPath: cfg.OutputPath,
		Sessions:      sessions,
		ExecCtx:       execCtx,
	}

	res, cmdConfig, err := api.RunExecPrepare(req, runCfg)
	if err != nil {
		return nil, err
	}

	runID, err := newRunID()
	if err != nil {
		res.Cleanup()
		return nil, fmt.Errorf("allocate run id: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)

	s.mu.Lock()
	s.runs[runID] = cancel
	s.mu.Unlock()

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.runs, runID)
			s.mu.Unlock()
			cancel()
			res.Cleanup()
		}()

		sink := &emitterExecSink{emitter: s.emitter, runID: runID}
		api.RunExecStream(ctx, req, runCfg, res, cmdConfig, sink)
	}()

	return &ExecRunResult{
		RunID:     runID,
		StartedAt: time.Now().Format(time.RFC3339),
	}, nil
}

// Cancel stops an in-flight run. No-op if the runID is unknown (the
// run may have already finished). Cancellation propagates via the
// context that RunExecStream is executing under, so the running
// process receives SIGKILL from the stdlib's exec.CommandContext.
func (s *ExecService) Cancel(runID string) error {
	s.mu.Lock()
	cancel := s.runs[runID]
	s.mu.Unlock()
	if cancel == nil {
		// Finished or never existed. Return nil so idempotent frontend
		// "cancel on unmount" paths don't surface spurious errors.
		return nil
	}
	cancel()
	return nil
}

func newRunID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// emitterExecSink implements api.ExecEventSink by emitting topic-scoped
// Wails events. Topic shape: `exec:<runID>:<event>`. The frontend
// subscribes to these after receiving runID from Run().
type emitterExecSink struct {
	emitter ports.Emitter
	runID   string
}

func (s *emitterExecSink) topic(event string) string {
	return fmt.Sprintf("exec:%s:%s", s.runID, event)
}

func (s *emitterExecSink) emit(event string, payload any) {
	if err := s.emitter.Emit(s.topic(event), payload); err != nil {
		slog.Warn("exec sink emit failed", "event", event, "runID", s.runID, "error", err)
	}
}

func (s *emitterExecSink) Log(line string, replace bool) {
	s.emit("log", api.ExecLogEvent{
		Line:      line,
		Timestamp: time.Now().Format(time.RFC3339),
		Replace:   replace,
	})
}

func (s *emitterExecSink) Status(status string, exitCode int) {
	s.emit("status", api.ExecStatusEvent{Status: status, ExitCode: exitCode})
}

func (s *emitterExecSink) Outputs(outputs map[string]string) {
	s.emit("outputs", api.BlockOutputsEvent{Outputs: outputs})
}

func (s *emitterExecSink) FilesCaptured(event api.FilesCapturedEvent) {
	s.emit("files_captured", event)
}

func (s *emitterExecSink) Error(message string) {
	s.emit("error", map[string]string{"message": message})
}

func (s *emitterExecSink) Done() {
	s.emit("done", struct{}{})
}
