package ports

import "context"

// GitHubUser is the subset of GitHub's /user response the application uses.
// Missing fields (Name, Email, AvatarURL) simply come back empty — GitHub
// returns them as JSON null for users who haven't set them, and no
// application code treats that as an error.
type GitHubUser struct {
	Login     string
	Name      string
	AvatarURL string
	Email     string
}

// GitHubClient is the port for GitHub REST + OAuth operations. Domain code
// never calls github.com directly; it depends on this port so a hosted
// deployment can swap in a tenant-scoped client (e.g. a GitHub App
// installation token scoped to a tenant's org) instead of relying on the
// user's personal token sitting in env vars or ~/.config/gh/.
//
// The interface will grow as more handlers migrate; this initial surface
// covers what HandleGitHubValidate needs.
type GitHubClient interface {
	// ValidateToken calls GET /user with the given bearer token and
	// returns the user plus the OAuth scopes from X-OAuth-Scopes.
	// Returns an error for HTTP 401 (invalid/expired token) or any
	// non-2xx response.
	ValidateToken(ctx context.Context, token string) (*GitHubUser, []string, error)
}
