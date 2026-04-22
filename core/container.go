// Package core is the composition root for domain packages. The
// Container bundles together the set of ports that domain code
// depends on so entry points (CLI, desktop, future hosted service)
// assemble one Container and hand the individual ports to whichever
// services need them.
//
// This is the explicit alternative to a DI framework. Plain struct
// injection keeps the adapter graph visible at the composition root
// and keeps wire-up readable at a glance.
package core

import "github.com/gruntwork-io/runbooks/core/ports"

// Container holds the ports a domain package may need. Not every
// service uses every port — services declare only the fields they
// depend on. The container is the single place entry points build
// to see the full set of adapters in one view.
type Container struct {
	Env     ports.Environment
	FS      ports.FileSystem
	Spawner ports.ProcessSpawner
	AWS     ports.AwsClient
	GitHub  ports.GitHubClient
	Git     ports.GitClient
	Emitter ports.Emitter
	Authz   ports.Authorizer
	Audit   ports.AuditLog
	Clock   ports.Clock
}
