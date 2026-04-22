// Package adapters contains OS-coupled implementations of core/ports.
//
// Everything that reaches for os, os/exec, syscall, filepath, or other
// host-specific APIs lives here, not in core/. Domain code in core/
// receives these adapters as interfaces via constructor injection, so
// the same domain code can later run against sandboxed or tenant-scoped
// adapters without modification.
package adapters
