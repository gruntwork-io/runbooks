package services

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/gruntwork-io/runbooks/adapters"
	"github.com/gruntwork-io/runbooks/api"
	"github.com/gruntwork-io/runbooks/core/ports"
)

// GitService is the Wails IPC wrapper around the filesystem git
// operations that today's /api/git/* HTTP endpoints drive: clone, push,
// open-pull-request, and delete-branch. The three streaming operations
// return a runID immediately and push progress through the emitter
// under `git:<runID>:<event>` topics, mirroring ExecService's pattern
// (see ExecService Run → `exec:<runID>:*`). DeleteBranch is a plain
// request/response since there's nothing to stream.
//
// Event shapes on emitted topics match the legacy SSE events exactly
// (ExecLogEvent / ExecStatusEvent / BlockOutputsEvent + named structs
// for clone_result / pr_result / error), so the frontend's Zod schemas
// work for both transports.
//
// GitHub REST API calls live in GitHubService; this service handles the
// `git` binary and repo filesystem state.
type GitService struct {
	servers *serverManager
	emitter ports.Emitter

	mu   sync.Mutex
	runs map[string]context.CancelFunc
}

// NewGitService constructs the GitService with a shared serverManager
// (so it sees the same session state as Gin and the other IPC services)
// and the emitter for streaming events.
func NewGitService(servers *serverManager, emitter ports.Emitter) *GitService {
	return &GitService{
		servers: servers,
		emitter: emitter,
		runs:    make(map[string]context.CancelFunc),
	}
}

// ServiceName satisfies application.ServiceName.
func (s *GitService) ServiceName() string { return "GitService" }

// GitRunResult is the synchronous return value of the streaming Git
// methods (Clone, Push, PullRequest). RunID is what the frontend
// subscribes to for `git:<runID>:*` events. Error is populated (with
// RunID empty) when pre-flight validation fails so the frontend can
// surface the error without attaching listeners.
//
// A pointer-to-shaped-error-or-nil is more Go-idiomatic than three
// separate return values across IPC, and the Wails TS codegen renders
// it as `error?: GitCloneError | GitPullRequestError`.
type GitRunResult struct {
	RunID     string `json:"runId,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`

	// CloneError is populated only by Clone and only when pre-flight
	// validation fails. Typed rather than a generic error so the
	// frontend can branch on Code=directory_exists and prompt.
	CloneError *api.GitCloneError `json:"cloneError,omitempty"`

	// Error is the generic pre-flight-failed message for Push and
	// PullRequest. Holds the GitPullRequestError shape in practice.
	Error *api.GitPullRequestError `json:"error,omitempty"`
}

// gitRunTimeout mirrors the 5-minute bound the legacy Gin handlers use
// for clone / PR / push streaming.
const gitRunTimeout = 5 * time.Minute

// Clone starts a git clone asynchronously. Pre-flight validation runs
// synchronously (URL shape, path-in-workdir, destination existence
// with Force handling, token injection) and surfaces as
// GitRunResult.CloneError when it fails. On success, RunID is returned
// and the frontend subscribes to `git:<runID>:*` for streaming output.
//
// Cancellation is via Cancel(runID). The 5-minute timeout matches the
// legacy SSE handler so long-running clones surface a clear failure
// rather than hanging indefinitely.
func (s *GitService) Clone(req api.GitCloneRequest) (*GitRunResult, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}

	cfg := s.servers.Config()
	tokens := api.NewTokenResolver(adapters.NewOsEnvironment(), adapters.NewOsProcessSpawner())

	plan, cerr := api.PrepareGitClone(req, cfg.WorkingDir, tokens, true)
	if cerr != nil {
		return &GitRunResult{CloneError: cerr}, nil
	}

	runID, err := newRunID()
	if err != nil {
		return nil, fmt.Errorf("allocate run id: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), gitRunTimeout)
	s.trackRun(runID, cancel)

	go func() {
		defer s.untrackRun(runID, cancel)
		sink := api.NewEmitterGitSink(s.emitter, runID)
		api.StreamGitClone(ctx, plan, sink)
	}()

	return &GitRunResult{
		RunID:     runID,
		StartedAt: time.Now().Format(time.RFC3339),
	}, nil
}

// Push stages + commits + pushes the current branch to origin. Thin
// wrapper over api.StreamGitPush with a runID + emitter sink.
func (s *GitService) Push(req api.GitPushRequest) (*GitRunResult, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}

	plan, cerr := api.PrepareGitPush(req, sessions)
	if cerr != nil {
		return &GitRunResult{Error: cerr}, nil
	}

	runID, err := newRunID()
	if err != nil {
		return nil, fmt.Errorf("allocate run id: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), gitRunTimeout)
	s.trackRun(runID, cancel)

	go func() {
		defer s.untrackRun(runID, cancel)
		sink := api.NewEmitterGitSink(s.emitter, runID)
		api.StreamGitPush(ctx, plan, sink)
	}()

	return &GitRunResult{
		RunID:     runID,
		StartedAt: time.Now().Format(time.RFC3339),
	}, nil
}

// PullRequest creates a branch + commit + push + GitHub PR in one
// flow. Emits step-by-step logs plus a `pr_result` event carrying the
// PR URL/number. If the target branch already exists, emits an
// `error` event with Code=branch_exists so the frontend can offer a
// "use a different branch name" prompt (same shape as the legacy SSE
// error event).
func (s *GitService) PullRequest(req api.CreatePullRequestRequest) (*GitRunResult, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}

	plan, cerr := api.PreparePullRequest(req, sessions)
	if cerr != nil {
		return &GitRunResult{Error: cerr}, nil
	}

	runID, err := newRunID()
	if err != nil {
		return nil, fmt.Errorf("allocate run id: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), gitRunTimeout)
	s.trackRun(runID, cancel)

	go func() {
		defer s.untrackRun(runID, cancel)
		sink := api.NewEmitterGitSink(s.emitter, runID)
		api.StreamPullRequest(ctx, plan, sink)
	}()

	return &GitRunResult{
		RunID:     runID,
		StartedAt: time.Now().Format(time.RFC3339),
	}, nil
}

// DeleteBranch deletes a local branch. Non-streaming: validation runs
// synchronously (protected-branch list, currently-checked-out guard,
// branch-name sanitization) and the git invocation is a quick
// `git branch -D`. Matches the legacy DELETE /api/git/branch endpoint.
func (s *GitService) DeleteBranch(req api.GitDeleteBranchRequest) (*api.GitDeleteBranchResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp := api.DeleteGitBranch(ctx, req)
	return &resp, nil
}

// Cancel stops an in-flight run (clone, push, or pull-request). Idempotent
// no-op when the runID is unknown — the run may have already finished,
// or the frontend is calling Cancel on unmount without distinguishing.
func (s *GitService) Cancel(runID string) error {
	s.mu.Lock()
	cancel := s.runs[runID]
	s.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	return nil
}

func (s *GitService) trackRun(runID string, cancel context.CancelFunc) {
	s.mu.Lock()
	s.runs[runID] = cancel
	s.mu.Unlock()
}

func (s *GitService) untrackRun(runID string, cancel context.CancelFunc) {
	s.mu.Lock()
	delete(s.runs, runID)
	s.mu.Unlock()
	cancel()
}
