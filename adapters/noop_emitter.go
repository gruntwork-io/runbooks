package adapters

import "github.com/gruntwork-io/runbooks/core/ports"

// NoopEmitter discards every emission. Used in CLI subcommands that
// don't have a transport to push events to (e.g. `gruntbooks test`),
// and as a safe default at composition roots still being wired up.
type NoopEmitter struct{}

func NewNoopEmitter() NoopEmitter { return NoopEmitter{} }

func (NoopEmitter) Emit(topic string, payload any) error { return nil }

var _ ports.Emitter = NoopEmitter{}
