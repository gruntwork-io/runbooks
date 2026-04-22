package adapters

import (
	"log/slog"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// LogEmitter writes emissions to slog at Debug level. Useful in CLI
// debugging and for integration tests that want to see what domain
// code is emitting without wiring up a real transport.
type LogEmitter struct{}

func NewLogEmitter() LogEmitter { return LogEmitter{} }

func (LogEmitter) Emit(topic string, payload any) error {
	slog.Debug("emit", "topic", topic, "payload", payload)
	return nil
}

var _ ports.Emitter = LogEmitter{}
