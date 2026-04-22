package fakes

import (
	"context"
	"sync"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// FakeAuditLog records every Record call so tests can assert that
// mutating operations audit with the expected action, resource, and
// outcome.
type FakeAuditLog struct {
	mu     sync.Mutex
	Events []ports.AuditEvent
	// Queued errors in FIFO order.
	Errs []error
}

// NewFakeAuditLog returns a recorder that accepts every event and
// returns nil until errors are queued.
func NewFakeAuditLog() *FakeAuditLog { return &FakeAuditLog{} }

func (f *FakeAuditLog) Record(ctx context.Context, event ports.AuditEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Events = append(f.Events, event)
	return popErr(&f.Errs)
}

// QueueErr queues an error for the next Record call.
func (f *FakeAuditLog) QueueErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Errs = append(f.Errs, err)
}

var _ ports.AuditLog = (*FakeAuditLog)(nil)
