package ports

import "context"

// Subject identifies the actor on whose behalf a request is being
// made. Desktop mode has a single local actor so Subject is mostly a
// placeholder, but the type exists from day one so every service
// entrypoint threads it through — hosted deployments then use Tenant
// and UserID to route authorization decisions per tenant without
// touching domain code.
type Subject struct {
	Tenant string
	UserID string
}

// Authorizer is the port for access-control checks. Every service
// entrypoint that performs a privileged action (executing a script,
// writing a file, using credentials, cloning a repo) calls Check so
// the call site exists regardless of deployment mode. Desktop ships
// NoopAuthorizer; hosted deployments swap in an OIDC/RBAC
// implementation at the composition root.
//
// Action is a short verb identifier (e.g. "exec.run",
// "credentials.use", "file.write"). Resource is a stable identifier
// for the thing being acted on (e.g. a script's content fingerprint,
// a file path, a credential profile name). An authorizer that denies
// a request returns a non-nil error; domain code propagates that
// error without interpretation.
type Authorizer interface {
	Check(ctx context.Context, subject Subject, action, resource string) error
}
