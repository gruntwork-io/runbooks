package fakes

import (
	"context"
	"fmt"
	"sync"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// FakeProcessSpawner is a scripted ProcessSpawner for tests. Each call to
// Run consumes one programmed response; calls beyond the programmed set
// return an error. LookPath consults a configurable map of executable
// names to resolved paths.
type FakeProcessSpawner struct {
	mu        sync.Mutex
	responses []FakeProcessResponse
	calls     []FakeProcessCall
	paths     map[string]string
}

// FakeProcessResponse is a scripted outcome for a single Run call.
type FakeProcessResponse struct {
	Result ports.ProcessResult
	Err    error
}

// FakeProcessCall records the request that was made to Run, so tests can
// assert on what the caller asked for.
type FakeProcessCall struct {
	Request ports.ProcessRequest
}

// NewFakeProcessSpawner returns a FakeProcessSpawner with no programmed
// responses and no path mappings.
func NewFakeProcessSpawner() *FakeProcessSpawner {
	return &FakeProcessSpawner{paths: make(map[string]string)}
}

// QueueRun adds a scripted response for the next Run call.
func (s *FakeProcessSpawner) QueueRun(result ports.ProcessResult, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.responses = append(s.responses, FakeProcessResponse{Result: result, Err: err})
}

// SetLookPath configures LookPath to return resolved for name. Passing an
// empty resolved causes LookPath to return ErrExecutableNotFound.
func (s *FakeProcessSpawner) SetLookPath(name, resolved string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.paths[name] = resolved
}

// Calls returns all Run calls recorded since construction.
func (s *FakeProcessSpawner) Calls() []FakeProcessCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]FakeProcessCall, len(s.calls))
	copy(out, s.calls)
	return out
}

func (s *FakeProcessSpawner) Run(ctx context.Context, req ports.ProcessRequest) (ports.ProcessResult, error) {
	s.mu.Lock()
	s.calls = append(s.calls, FakeProcessCall{Request: req})
	if len(s.responses) == 0 {
		s.mu.Unlock()
		return ports.ProcessResult{}, fmt.Errorf("fake process spawner: no response queued for %s", req.Name)
	}
	resp := s.responses[0]
	s.responses = s.responses[1:]
	s.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return ports.ProcessResult{}, err
	}
	return resp.Result, resp.Err
}

func (s *FakeProcessSpawner) LookPath(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	resolved, ok := s.paths[name]
	if !ok || resolved == "" {
		return "", fmt.Errorf("%s: %w", name, ports.ErrExecutableNotFound)
	}
	return resolved, nil
}

var _ ports.ProcessSpawner = (*FakeProcessSpawner)(nil)
