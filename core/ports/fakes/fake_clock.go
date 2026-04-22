package fakes

import (
	"sync"
	"time"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// FakeClock returns a fixed time, advanceable via Advance or
// repositionable via SetTime. Tests that assert on timestamps use
// this so results are deterministic without freezing the host clock.
type FakeClock struct {
	mu      sync.Mutex
	current time.Time
}

// NewFakeClock returns a clock whose Now returns t until SetTime or
// Advance is called.
func NewFakeClock(t time.Time) *FakeClock { return &FakeClock{current: t} }

func (f *FakeClock) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.current
}

// SetTime resets the clock to t.
func (f *FakeClock) SetTime(t time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = t
}

// Advance moves the clock forward by d.
func (f *FakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = f.current.Add(d)
}

var _ ports.Clock = (*FakeClock)(nil)
