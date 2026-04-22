package ports

import "time"

// Clock is the port for reading wall-clock time. Domain code takes a
// Clock so tests can assert on timestamps without depending on the
// host system clock, and so a future hosted deployment can swap in a
// clock that respects tenant-configured time zones or test overrides.
type Clock interface {
	Now() time.Time
}
