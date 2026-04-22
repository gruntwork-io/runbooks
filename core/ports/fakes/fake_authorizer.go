package fakes

import (
	"context"
	"sync"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// FakeAuthorizeCall records a single Check invocation.
type FakeAuthorizeCall struct {
	Subject  ports.Subject
	Action   string
	Resource string
}

// FakeAuthorizer records every Check call and either allows (default)
// or returns a queued error. Tests assert against Calls to verify
// that domain code calls Check at the right boundaries with the
// right (action, resource) pair.
type FakeAuthorizer struct {
	mu    sync.Mutex
	Calls []FakeAuthorizeCall
	// Queued errors in FIFO order. Empty queue = allow.
	Errs []error
}

// NewFakeAuthorizer returns an authorizer that allows every call
// and records each invocation. Queue errors via QueueErr to
// exercise denial paths.
func NewFakeAuthorizer() *FakeAuthorizer { return &FakeAuthorizer{} }

func (f *FakeAuthorizer) Check(ctx context.Context, subject ports.Subject, action, resource string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, FakeAuthorizeCall{Subject: subject, Action: action, Resource: resource})
	return popErr(&f.Errs)
}

// QueueErr queues an error for the next Check call.
func (f *FakeAuthorizer) QueueErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Errs = append(f.Errs, err)
}

var _ ports.Authorizer = (*FakeAuthorizer)(nil)
