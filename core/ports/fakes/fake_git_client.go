package fakes

import (
	"context"
	"sync"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// FakeGitClient is a scripted GitClient for tests. Each Clone call
// pops the next response from CloneResponses; if the queue is empty,
// the canned Output is returned. Errors are queued separately so
// tests can script (success, transient-error, success) scenarios.
type FakeGitClient struct {
	mu sync.Mutex

	// Canned default output returned when no queued response is
	// available. Most tests don't care about output bytes and can
	// leave this nil.
	Output []byte

	// Queued outputs (FIFO). Each entry overrides Output for a
	// single call.
	CloneResponses [][]byte

	// Queued errors (FIFO). Consumed in lock-step with Clone calls.
	// If an error is queued for the current call, the matching
	// response's output is still returned alongside it (matching
	// the real CLI's behavior of emitting stderr before exiting
	// non-zero).
	CloneErrs []error

	// Call log: records every Clone invocation's request. Tests
	// assert against this to confirm the handler passed the right
	// URL / dest / ref / repo-path through.
	Calls []FakeGitCall
}

// FakeGitCall records a single invocation on FakeGitClient.
type FakeGitCall struct {
	Method  string
	Request ports.GitCloneRequest
}

// NewFakeGitClient returns a fake with the given canned output (pass
// nil for tests that don't care about output bytes).
func NewFakeGitClient(output []byte) *FakeGitClient {
	return &FakeGitClient{Output: output}
}

func (f *FakeGitClient) Clone(ctx context.Context, req ports.GitCloneRequest) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.Calls = append(f.Calls, FakeGitCall{Method: "Clone", Request: req})

	var output []byte
	if len(f.CloneResponses) > 0 {
		output = f.CloneResponses[0]
		f.CloneResponses = f.CloneResponses[1:]
	} else {
		output = f.Output
	}
	if err := popErr(&f.CloneErrs); err != nil {
		return output, err
	}
	return output, nil
}

// QueueCloneErr queues an error to be returned by the next Clone call.
// The matching response's output (or the canned Output) is still
// returned alongside the error.
func (f *FakeGitClient) QueueCloneErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.CloneErrs = append(f.CloneErrs, err)
}

// QueueCloneResponse queues an output to be returned by the next
// Clone call, overriding the canned Output for that single call.
func (f *FakeGitClient) QueueCloneResponse(output []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.CloneResponses = append(f.CloneResponses, output)
}

var _ ports.GitClient = (*FakeGitClient)(nil)
