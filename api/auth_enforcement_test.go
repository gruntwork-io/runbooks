package api

import (
	"net/http"
	"testing"
)

// =============================================================================
// Protected Endpoint Auth Enforcement Tests
// =============================================================================
//
// These tests enforce that ALL endpoints behind SessionAuthMiddleware reject
// unauthenticated requests. This is the single source of truth for which
// endpoints require auth.
//
// WHY THIS EXISTS:
// A past bug was caused by moving an endpoint into the protectedAPI group
// without updating the frontend to send the Authorization header. The backend
// correctly returned 401, but the frontend didn't know it needed auth. This
// test ensures the backend side stays correct. If you're REMOVING auth
// protection from an endpoint, you should consciously remove it from this
// list too — that forces a deliberate decision rather than an accidental one.
//
// HOW TO MAINTAIN:
// When you add a new endpoint to the protectedAPI or sessionAuth group in
// server.go, add a corresponding entry here. The test will verify it rejects
// unauthenticated requests (no token → 401, invalid token → 401) and accepts
// valid tokens (valid token → not 401).

// allProtectedEndpoints is the exhaustive list of endpoints that require
// session auth. This MUST match the protectedAPI and sessionAuth groups
// in server.go. Keep it in the same order as server.go for easy comparison.
var allProtectedEndpoints = []protectedEndpoint{
	// --- Session-scoped endpoints (sessionAuth group) ---
	{Name: "/api/session (GET)", Method: http.MethodGet, Path: "/api/session"},
	{Name: "/api/session/reset", Path: "/api/session/reset"},
	{Name: "/api/session (DELETE)", Method: http.MethodDelete, Path: "/api/session"},
	{Name: "/api/session/env", Method: http.MethodPatch, Path: "/api/session/env", Body: SetEnvRequest{Env: map[string]string{"FOO": "bar"}}},

	// --- Execution endpoint ---
	{Name: "/api/exec", Path: "/api/exec", Body: ExecRequest{}},

	// --- AWS auth endpoints (return credentials) ---
	{Name: "/api/aws/env-credentials", Method: http.MethodGet, Path: "/api/aws/env-credentials"},
	{Name: "/api/aws/env-credentials/confirm", Path: "/api/aws/env-credentials/confirm", Body: ConfirmEnvCredentialsRequest{}},
	{Name: "/api/aws/profile", Path: "/api/aws/profile", Body: ProfileAuthRequest{Profile: "default"}},
	{Name: "/api/aws/sso/poll", Path: "/api/aws/sso/poll", Body: SSOPollRequest{ClientID: "test", ClientSecret: "test", DeviceCode: "test"}},
	{Name: "/api/aws/sso/complete", Path: "/api/aws/sso/complete", Body: SSOCompleteRequest{AccessToken: "test", AccountID: "123456789012", RoleName: "test"}},

	// --- GitHub auth endpoints (return credentials) ---
	{Name: "/api/github/oauth/poll", Path: "/api/github/oauth/poll", Body: GitHubOAuthPollRequest{ClientID: "test", DeviceCode: "test"}},
	{Name: "/api/github/env-credentials", Path: "/api/github/env-credentials", Body: GitHubEnvCredentialsRequest{GitHubAuthID: "test"}},
	{Name: "/api/github/cli-credentials", Path: "/api/github/cli-credentials", Body: struct{ GitHubAuthID string }{GitHubAuthID: "test"}},

	// --- GitHub browsing endpoints (require session for token) ---
	{Name: "/api/github/orgs", Method: http.MethodGet, Path: "/api/github/orgs"},
	{Name: "/api/github/repos", Method: http.MethodGet, Path: "/api/github/repos?org=test"},
	{Name: "/api/github/refs", Method: http.MethodGet, Path: "/api/github/refs?owner=test&repo=test"},

	// --- Git clone endpoint ---
	{Name: "/api/git/clone", Path: "/api/git/clone", Body: GitCloneRequest{URL: "https://github.com/org/repo", LocalPath: "/tmp"}},

	// --- GitHub pull request endpoints ---
	{Name: "/api/github/labels", Method: http.MethodGet, Path: "/api/github/labels?owner=test&repo=test"},
	{Name: "/api/git/pull-request", Path: "/api/git/pull-request", Body: CreatePullRequestRequest{Title: "test", BranchName: "test", LocalPath: "/tmp", RepoURL: "https://github.com/org/repo"}},
	{Name: "/api/git/push", Path: "/api/git/push", Body: GitPushRequest{LocalPath: "/tmp", BranchName: "test"}},
	{Name: "/api/git/branch", Method: http.MethodDelete, Path: "/api/git/branch", Body: GitDeleteBranchRequest{LocalPath: "/tmp", BranchName: "test"}},

	// --- OpenTofu module parsing ---
	{Name: "/api/tf/parse", Path: "/api/tf/parse", Body: TfParseRequest{Source: "."}},

	// --- Workspace endpoints ---
	{Name: "/api/workspace/tree", Method: http.MethodGet, Path: "/api/workspace/tree"},
	{Name: "/api/workspace/dirs", Method: http.MethodGet, Path: "/api/workspace/dirs"},
	{Name: "/api/workspace/file", Method: http.MethodGet, Path: "/api/workspace/file?path=/tmp"},
	{Name: "/api/workspace/changes", Method: http.MethodGet, Path: "/api/workspace/changes"},
	{Name: "/api/workspace/register", Path: "/api/workspace/register"},
	{Name: "/api/workspace/set-active", Path: "/api/workspace/set-active"},
}

// TestAllProtectedEndpointsRequireAuth verifies that EVERY endpoint behind
// SessionAuthMiddleware rejects requests without a valid Authorization header.
// If this test fails after adding a new protected endpoint, add it to
// allProtectedEndpoints above.
func TestAllProtectedEndpointsRequireAuth(t *testing.T) {
	sm := NewSessionManager()
	router := setupTestRouter(t, sm)
	assertEndpointsRequireAuth(t, router, allProtectedEndpoints)
}

// TestAllProtectedEndpointsAcceptValidToken verifies that requests with a valid
// session token pass the auth middleware. The requests may still fail for other
// reasons (e.g., invalid AWS credentials, missing parameters), but they should
// NOT return 401.
func TestAllProtectedEndpointsAcceptValidToken(t *testing.T) {
	sm := NewSessionManager()
	assertEndpointsAcceptValidToken(t, sm, allProtectedEndpoints)
}
