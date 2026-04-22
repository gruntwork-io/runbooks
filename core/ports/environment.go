package ports

// Environment is a read-only view of environment variables.
//
// Domain code reads env vars exclusively through this port. The desktop
// adapter reads from os.Environ(). A hosted adapter would read from a
// tenant-scoped allowlist, preventing domain code from probing env vars
// it has no business seeing.
//
// The port is intentionally read-only. Mutating the host process
// environment is never a domain concern — environments passed to child
// processes are built explicitly by the Session and handed to the
// ProcessSpawner.
type Environment interface {
	// Get returns the value of key and whether it was set. An empty string
	// with ok=true means the var was set to the empty string, which is
	// distinct from unset (ok=false).
	Get(key string) (value string, ok bool)

	// GetAll returns a snapshot of all environment variables as a map.
	// The returned map is owned by the caller; mutating it does not
	// affect the underlying environment.
	GetAll() map[string]string
}
