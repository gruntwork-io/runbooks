package adapters

import (
	"context"
	"testing"
	"time"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// ---------------------------------------------------------------------------
// NoopEmitter
// ---------------------------------------------------------------------------

func TestNoopEmitter_EmitReturnsNil(t *testing.T) {
	e := NewNoopEmitter()
	if err := e.Emit("exec:run:log", map[string]any{"line": "hello"}); err != nil {
		t.Errorf("Emit: want nil, got %v", err)
	}
}

func TestNoopEmitter_EmitEmptyTopic(t *testing.T) {
	e := NewNoopEmitter()
	if err := e.Emit("", nil); err != nil {
		t.Errorf("Emit empty topic: want nil, got %v", err)
	}
}

func TestNoopEmitter_ImplementsEmitter(t *testing.T) {
	var _ ports.Emitter = NewNoopEmitter()
}

// ---------------------------------------------------------------------------
// LogEmitter
// ---------------------------------------------------------------------------

func TestLogEmitter_EmitReturnsNil(t *testing.T) {
	e := NewLogEmitter()
	if err := e.Emit("exec:run:log", "some payload"); err != nil {
		t.Errorf("Emit: want nil, got %v", err)
	}
}

func TestLogEmitter_EmitNilPayload(t *testing.T) {
	e := NewLogEmitter()
	if err := e.Emit("topic", nil); err != nil {
		t.Errorf("Emit nil payload: want nil, got %v", err)
	}
}

func TestLogEmitter_ImplementsEmitter(t *testing.T) {
	var _ ports.Emitter = NewLogEmitter()
}

// ---------------------------------------------------------------------------
// NoopAuditLog
// ---------------------------------------------------------------------------

func TestNoopAuditLog_RecordReturnsNil(t *testing.T) {
	a := NewNoopAuditLog()
	event := ports.AuditEvent{
		Time:     time.Now(),
		Subject:  ports.Subject{Tenant: "local", UserID: "alice"},
		Action:   "exec.run",
		Resource: "sha256:abc123",
		Outcome:  ports.AuditOutcomeSuccess,
		Details:  map[string]any{"script": "echo hello"},
	}
	if err := a.Record(context.Background(), event); err != nil {
		t.Errorf("Record: want nil, got %v", err)
	}
}

func TestNoopAuditLog_RecordZeroEventReturnsNil(t *testing.T) {
	a := NewNoopAuditLog()
	if err := a.Record(context.Background(), ports.AuditEvent{}); err != nil {
		t.Errorf("Record zero event: want nil, got %v", err)
	}
}

func TestNoopAuditLog_ImplementsAuditLog(t *testing.T) {
	var _ ports.AuditLog = NewNoopAuditLog()
}

// ---------------------------------------------------------------------------
// NoopAuthorizer
// ---------------------------------------------------------------------------

func TestNoopAuthorizer_CheckReturnsNil(t *testing.T) {
	az := NewNoopAuthorizer()
	subject := ports.Subject{Tenant: "local", UserID: "alice"}
	if err := az.Check(context.Background(), subject, "exec.run", "sha256:abc"); err != nil {
		t.Errorf("Check: want nil, got %v", err)
	}
}

func TestNoopAuthorizer_CheckEmptySubjectReturnsNil(t *testing.T) {
	az := NewNoopAuthorizer()
	if err := az.Check(context.Background(), ports.Subject{}, "", ""); err != nil {
		t.Errorf("Check empty subject: want nil, got %v", err)
	}
}

func TestNoopAuthorizer_ImplementsAuthorizer(t *testing.T) {
	var _ ports.Authorizer = NewNoopAuthorizer()
}

// ---------------------------------------------------------------------------
// Regression: noop adapters must never inspect context cancellation
// ---------------------------------------------------------------------------

func TestNoopAdapters_CancelledContextDoesNotCauseError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	if err := NewNoopAuditLog().Record(ctx, ports.AuditEvent{}); err != nil {
		t.Errorf("NoopAuditLog.Record with cancelled ctx: want nil, got %v", err)
	}
	if err := NewNoopAuthorizer().Check(ctx, ports.Subject{}, "any", "any"); err != nil {
		t.Errorf("NoopAuthorizer.Check with cancelled ctx: want nil, got %v", err)
	}
}