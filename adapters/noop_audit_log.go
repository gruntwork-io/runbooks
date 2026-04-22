package adapters

import (
	"context"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// NoopAuditLog discards audit events. Desktop mode uses this because
// a single-user local context has limited value for an audit trail.
// Hosted deployments swap in a database- or SIEM-backed adapter at
// the composition root.
type NoopAuditLog struct{}

func NewNoopAuditLog() NoopAuditLog { return NoopAuditLog{} }

func (NoopAuditLog) Record(ctx context.Context, event ports.AuditEvent) error {
	return nil
}

var _ ports.AuditLog = NoopAuditLog{}
