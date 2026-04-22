package fakes

import (
	"context"
	"sync"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// FakeGitHubClient is a scripted GitHubClient for tests. Each call pops
// the next response from ValidateResponses; if the queue is empty, the
// canned User/Scopes are returned. Errors are queued separately so tests
// can script (user-hit, transient-error, user-hit) scenarios.
type FakeGitHubClient struct {
	mu sync.Mutex

	// Canned default response when no queued response is available.
	User   *ports.GitHubUser
	Scopes []string

	// Queued responses (FIFO). Each entry overrides User/Scopes for a
	// single call.
	ValidateResponses []FakeGitHubValidate

	// Queued errors (FIFO). Consumed in lock-step with ValidateToken
	// calls — if an error is queued, it's returned; otherwise the
	// response/canned value is returned.
	ValidateErrs []error

	// Call log: records every ValidateToken invocation's token argument.
	// Tests assert against this to confirm the handler passed the right
	// token through.
	Calls []FakeGitHubCall
}

// FakeGitHubValidate is a single queued response for ValidateToken.
type FakeGitHubValidate struct {
	User   *ports.GitHubUser
	Scopes []string
}

// FakeGitHubCall records a single invocation on FakeGitHubClient.
type FakeGitHubCall struct {
	Method string
	Token  string
}

// NewFakeGitHubClient returns a fake with the given canned user (pass
// nil to start without one). Tests override User/Scopes or queue
// responses via the exported fields.
func NewFakeGitHubClient(user *ports.GitHubUser) *FakeGitHubClient {
	return &FakeGitHubClient{User: user}
}

func (f *FakeGitHubClient) ValidateToken(ctx context.Context, token string) (*ports.GitHubUser, []string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.Calls = append(f.Calls, FakeGitHubCall{Method: "ValidateToken", Token: token})

	if err := popErr(&f.ValidateErrs); err != nil {
		return nil, nil, err
	}
	if len(f.ValidateResponses) > 0 {
		resp := f.ValidateResponses[0]
		f.ValidateResponses = f.ValidateResponses[1:]
		return resp.User, resp.Scopes, nil
	}
	return f.User, f.Scopes, nil
}

// QueueValidateErr queues an error to be returned by the next
// ValidateToken call.
func (f *FakeGitHubClient) QueueValidateErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ValidateErrs = append(f.ValidateErrs, err)
}

// QueueValidateResponse queues a response for the next ValidateToken
// call, overriding the canned User/Scopes for that single call.
func (f *FakeGitHubClient) QueueValidateResponse(user *ports.GitHubUser, scopes []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ValidateResponses = append(f.ValidateResponses, FakeGitHubValidate{User: user, Scopes: scopes})
}

var _ ports.GitHubClient = (*FakeGitHubClient)(nil)
