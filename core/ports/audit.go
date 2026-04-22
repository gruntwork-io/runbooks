package ports

import (
	"context"
	"time"
)

// AuditOutcome is a small enum for whether the audited action
// succeeded, failed on its own merits, or was denied by policy.
// Strings are used (not ints) so JSON-serialized audit logs stay
// human-readable without a lookup table.
type AuditOutcome string

const (
	AuditOutcomeSuccess AuditOutcome = "success"
	AuditOutcomeFailure AuditOutcome = "failure"
	AuditOutcomeDenied  AuditOutcome = "denied"
)

// AuditEvent is a single record of a mutating action. Domain code
// constructs these with no knowledge of where they'll be persisted;
// adapters choose between stderr, a local JSON file, or a hosted
// database.
//
// Details is intentionally open-shape so subsystem-specific context
// (script fingerprint, target region, repo URL) can ride along
// without requiring a schema change for every new action.
type AuditEvent struct {
	Time     time.Time
	Subject  Subject
	Action   string
	Resource string
	Outcome  AuditOutcome
	Details  map[string]any
}

// AuditLog is the port for recording that a mutating action
// happened. Called for every exec, credential use, file write, and
// clone so a hosted deployment has the trail it needs for compliance
// and forensics. Desktop uses NoopAuditLog (or a local-file adapter
// when the user wants an on-disk trail) — the call sites in domain
// code are identical regardless.
type AuditLog interface {
	Record(ctx context.Context, event AuditEvent) error
}
