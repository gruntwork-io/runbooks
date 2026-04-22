package fakes

import (
	"sync"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// FakeEmitEvent is a single recorded emission.
type FakeEmitEvent struct {
	Topic   string
	Payload any
}

// FakeEmitter records every Emit call so tests can assert the stream
// of events produced by domain code. Errors can be queued to
// exercise failure paths (e.g. "transport disconnected mid-stream").
// Safe for concurrent use.
type FakeEmitter struct {
	mu     sync.Mutex
	Events []FakeEmitEvent
	// Queued errors in FIFO order. Each Emit call pops one; when
	// the queue is empty, Emit returns nil.
	Errs []error
}

// NewFakeEmitter returns an emitter that records events and returns
// nil from every Emit call until errors are queued.
func NewFakeEmitter() *FakeEmitter { return &FakeEmitter{} }

func (f *FakeEmitter) Emit(topic string, payload any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Events = append(f.Events, FakeEmitEvent{Topic: topic, Payload: payload})
	return popErr(&f.Errs)
}

// QueueErr queues an error for the next Emit call.
func (f *FakeEmitter) QueueErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Errs = append(f.Errs, err)
}

// EventsForTopic returns recorded events whose topic matches
// exactly. Useful for asserting on a single stream without
// filtering in the test.
func (f *FakeEmitter) EventsForTopic(topic string) []FakeEmitEvent {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []FakeEmitEvent
	for _, e := range f.Events {
		if e.Topic == topic {
			out = append(out, e)
		}
	}
	return out
}

var _ ports.Emitter = (*FakeEmitter)(nil)
