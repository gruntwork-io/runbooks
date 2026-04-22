// Package services holds the Wails v3 IPC services that back the desktop
// UI. Each service is registered via application.NewService(&svc) and has
// its methods automatically exposed to the frontend through wails3
// generate bindings.
//
// M2 scope is intentionally narrow: WelcomeService drives the welcome
// screen (folder picker, recent list, open-local/open-remote) and kicks
// off the embedded Gin backend that continues to serve the rest of the
// runbook experience over HTTP. Later milestones (M3/M4) migrate those
// remaining HTTP endpoints to IPC services that live in this package.
package services
