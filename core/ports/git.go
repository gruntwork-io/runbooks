package ports

import "context"

// GitCloneRequest describes a git clone operation. URL should already
// have any auth token injected (see InjectGitToken) — the port does
// not read environment or secrets itself.
type GitCloneRequest struct {
	// URL is the clone URL (https://..., git://, git@host:..., file://).
	URL string

	// DestPath is the local directory to clone into.
	DestPath string

	// Ref is an optional branch or tag name (passed via --branch).
	Ref string

	// RepoPath, if non-empty, triggers a sparse checkout that keeps
	// only this subdirectory of the repo (--filter=blob:none +
	// sparse-checkout set + checkout).
	RepoPath string
}

// GitClient is the port for local git operations. Today's sole
// implementation shells out to the `git` CLI; a hosted deployment
// could swap in a libgit2-backed or sandboxed version without
// touching callers.
//
// The interface will grow as more handlers migrate; this initial
// surface covers the non-streaming clone used by the CLI remote-open
// path, the Terraform module resolver, and the headless test runner.
// Streaming clones (SSE-driven HandleGitClone) need an Emitter port
// and are deferred to the next milestone.
type GitClient interface {
	// Clone performs the clone described by req. The returned bytes
	// are combined stdout+stderr — useful for error classification
	// (auth vs network vs ref-not-found). When err is non-nil, the
	// output is returned alongside rather than discarded so callers
	// that need to show it to the user can.
	Clone(ctx context.Context, req GitCloneRequest) ([]byte, error)
}
