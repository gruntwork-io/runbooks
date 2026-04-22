// Package ports defines the interfaces that domain code depends on.
//
// Domain code in core/ must import only from core/ports/ and standard
// library packages that are not OS-coupled (no os, os/exec, syscall,
// net/http, etc.). OS-coupled implementations live in the adapters
// package.
//
// Each entry point (desktop, CLI, future hosted service) composes a
// set of adapters that satisfy these ports. This lets the same domain
// code run in a desktop app reading the user's real environment and,
// later, in a multi-tenant service with env vars scoped per tenant,
// filesystem calls confined to a per-tenant directory, and process
// spawning routed through a sandbox.
package ports
