// Package fakes provides in-memory implementations of core/ports interfaces
// for use in tests. Fakes are safe to use in unit tests without touching the
// host filesystem, environment, or process table.
package fakes

import (
	"sync"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// FakeEnvironment is an in-memory Environment backed by a map.
type FakeEnvironment struct {
	mu   sync.RWMutex
	vars map[string]string
}

// NewFakeEnvironment returns a FakeEnvironment seeded with the given vars.
// Pass nil to start with an empty environment.
func NewFakeEnvironment(vars map[string]string) *FakeEnvironment {
	env := &FakeEnvironment{vars: make(map[string]string, len(vars))}
	for k, v := range vars {
		env.vars[k] = v
	}
	return env
}

// Set records a variable in the fake environment (test helper; not part of
// the Environment port).
func (e *FakeEnvironment) Set(key, value string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.vars[key] = value
}

// Unset removes a variable from the fake environment (test helper).
func (e *FakeEnvironment) Unset(key string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.vars, key)
}

func (e *FakeEnvironment) Get(key string) (string, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	v, ok := e.vars[key]
	return v, ok
}

func (e *FakeEnvironment) GetAll() map[string]string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make(map[string]string, len(e.vars))
	for k, v := range e.vars {
		out[k] = v
	}
	return out
}

var _ ports.Environment = (*FakeEnvironment)(nil)
