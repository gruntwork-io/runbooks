package adapters

import (
	"context"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// NoopAuthorizer allows every action. Desktop mode uses this because
// the actor is always the single local user — there is no other
// principal to authorize against. Hosted deployments swap this for
// an OIDC- or RBAC-backed implementation at the composition root.
type NoopAuthorizer struct{}

func NewNoopAuthorizer() NoopAuthorizer { return NoopAuthorizer{} }

func (NoopAuthorizer) Check(ctx context.Context, subject ports.Subject, action, resource string) error {
	return nil
}

var _ ports.Authorizer = NoopAuthorizer{}
