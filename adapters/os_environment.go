package adapters

import (
	"os"
	"strings"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// OsEnvironment implements ports.Environment using the host process's
// real environment via os.LookupEnv and os.Environ.
type OsEnvironment struct{}

// NewOsEnvironment returns an Environment backed by the host process.
func NewOsEnvironment() *OsEnvironment {
	return &OsEnvironment{}
}

// Get returns the value of key from the host process environment.
func (e *OsEnvironment) Get(key string) (string, bool) {
	return os.LookupEnv(key)
}

// GetAll returns a snapshot of the host process environment.
func (e *OsEnvironment) GetAll() map[string]string {
	entries := os.Environ()
	out := make(map[string]string, len(entries))
	for _, kv := range entries {
		if idx := strings.Index(kv, "="); idx != -1 {
			out[kv[:idx]] = kv[idx+1:]
		}
	}
	return out
}

// Compile-time check that OsEnvironment implements the port.
var _ ports.Environment = (*OsEnvironment)(nil)
