package adapters

import (
	"time"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// SystemClock reads the host's wall clock. Used everywhere except
// tests (which use fakes.FakeClock) and hosted deployments that
// need a controlled clock.
type SystemClock struct{}

// NewSystemClock returns a SystemClock instance. The struct is
// empty so the constructor is a convenience; the value type is
// also safe to use directly.
func NewSystemClock() SystemClock { return SystemClock{} }

func (SystemClock) Now() time.Time { return time.Now() }

var _ ports.Clock = SystemClock{}
