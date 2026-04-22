package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gruntwork-io/runbooks/core/ports/fakes"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInjectGitToken(t *testing.T) {
	tests := []struct {
		name     string
		rawURL   string
		token    string
		expected string
	}{
		{
			name:     "HTTPS URL gets token injected",
			rawURL:   "https://github.com/org/repo.git",
			token:    "ghp_abc123",
			expected: "https://x-access-token:ghp_abc123@github.com/org/repo.git",
		},
		{
			name:     "HTTPS URL without .git suffix",
			rawURL:   "https://github.com/org/repo",
			token:    "ghp_abc123",
			expected: "https://x-access-token:ghp_abc123@github.com/org/repo",
		},
		{
			name:     "SSH URL is returned unchanged",
			rawURL:   "git@github.com:org/repo.git",
			token:    "ghp_abc123",
			expected: "git@github.com:org/repo.git",
		},
		{
			name:     "HTTP URL is returned unchanged (not HTTPS)",
			rawURL:   "http://github.com/org/repo.git",
			token:    "ghp_abc123",
			expected: "http://github.com/org/repo.git",
		},
		{
			name:     "empty URL returned unchanged",
			rawURL:   "",
			token:    "ghp_abc123",
			expected: "",
		},
		{
			name:     "empty token returns URL unchanged",
			rawURL:   "https://github.com/org/repo.git",
			token:    "",
			expected: "https://github.com/org/repo.git",
		},
		{
			name:     "URL with existing user info gets overwritten",
			rawURL:   "https://olduser:oldpass@github.com/org/repo.git",
			token:    "ghp_new",
			expected: "https://x-access-token:ghp_new@github.com/org/repo.git",
		},
		{
			name:     "GitLab URL uses oauth2 username",
			rawURL:   "https://gitlab.com/org/repo.git",
			token:    "glpat_abc123",
			expected: "https://oauth2:glpat_abc123@gitlab.com/org/repo.git",
		},
		{
			name:     "GitLab URL without .git suffix",
			rawURL:   "https://gitlab.com/org/repo",
			token:    "glpat_abc123",
			expected: "https://oauth2:glpat_abc123@gitlab.com/org/repo",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := InjectGitToken(tc.rawURL, tc.token)
			if result != tc.expected {
				t.Errorf("InjectGitToken(%q, %q) = %q, want %q", tc.rawURL, tc.token, result, tc.expected)
			}
		})
	}
}

func TestSanitizeGitError(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "removes token from error message",
			input:    "fatal: unable to access 'https://x-access-token:ghp_secret123@github.com/org/repo.git/': The requested URL returned error: 403",
			expected: "fatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 403",
		},
		{
			name:     "message without token is unchanged",
			input:    "fatal: not a git repository",
			expected: "fatal: not a git repository",
		},
		{
			name:     "empty message",
			input:    "",
			expected: "",
		},
		{
			name:     "removes multiple tokens in one message",
			input:    "x-access-token:abc@github.com and x-access-token:def@gitlab.com",
			expected: "github.com and gitlab.com",
		},
		{
			name:     "removes oauth2 token from GitLab URL",
			input:    "fatal: unable to access 'https://oauth2:glpat_secret@gitlab.com/org/repo.git/': The requested URL returned error: 403",
			expected: "fatal: unable to access 'https://gitlab.com/org/repo.git/': The requested URL returned error: 403",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := SanitizeGitError(tc.input)
			if result != tc.expected {
				t.Errorf("SanitizeGitError(%q) = %q, want %q", tc.input, result, tc.expected)
			}
		})
	}
}

func TestIsValidGitHubOwner(t *testing.T) {
	tests := []struct {
		name     string
		owner    string
		expected bool
	}{
		// Valid owners
		{"simple name", "octocat", true},
		{"with hyphens", "my-org", true},
		{"single char", "a", true},
		{"alphanumeric", "org123", true},
		{"starts with number", "1org", true},

		// Invalid owners
		{"empty string", "", false},
		{"starts with hyphen", "-org", false},
		{"ends with hyphen", "org-", false},
		{"contains space", "my org", false},
		{"contains dot", "my.org", false},
		{"contains underscore", "my_org", false},
		{"too long (40 chars)", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false},
		{"exactly 39 chars is valid", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isValidGitHubOwner(tc.owner)
			if result != tc.expected {
				t.Errorf("isValidGitHubOwner(%q) = %v, want %v", tc.owner, result, tc.expected)
			}
		})
	}
}

func TestIsValidGitHubRepoName(t *testing.T) {
	tests := []struct {
		name     string
		repoName string
		expected bool
	}{
		// Valid repo names
		{"simple name", "my-repo", true},
		{"with dots", "repo.js", true},
		{"with underscores", "my_repo", true},
		{"alphanumeric only", "repo123", true},
		{"single char", "r", true},
		{"all allowed chars", "My-Repo_v2.0", true},

		// Invalid repo names
		{"empty string", "", false},
		{"contains space", "my repo", false},
		{"contains slash", "org/repo", false},
		{"contains at sign", "repo@v2", false},
		{"too long (101 chars)", string(make([]byte, 101)), false},
	}

	// Fix the "too long" test case — make([]byte, 101) gives null bytes, use a proper string
	tests[len(tests)-1].repoName = func() string {
		b := make([]byte, 101)
		for i := range b {
			b[i] = 'a'
		}
		return string(b)
	}()

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isValidGitHubRepoName(tc.repoName)
			if result != tc.expected {
				t.Errorf("isValidGitHubRepoName(%q) = %v, want %v", tc.repoName, result, tc.expected)
			}
		})
	}
}

// TestGitCloneUsesInitialWorkDir verifies that HandleGitClone resolves clone
// paths relative to the initial working directory (passed at server start),
// NOT the session's current working directory. This prevents the second
// GitClone from nesting inside the first clone when a Command block changes
// the session's working directory in between (issue #94).
func TestGitCloneUsesInitialWorkDir(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Create the initial working directory and a subdirectory that simulates
	// the result of a previous clone + cd.
	initialWorkDir := t.TempDir()
	subDir := filepath.Join(initialWorkDir, "repo-a")
	require.NoError(t, os.MkdirAll(subDir, 0o755))

	// Set up session with initial working directory
	sm := NewSessionManager()
	sessionResp, err := sm.CreateSession(initialWorkDir)
	require.NoError(t, err)

	// Simulate a Command block changing the session's working directory
	// (this is what happens when a script does `cd repo-a`)
	err = sm.UpdateSessionEnv(map[string]string{}, subDir)
	require.NoError(t, err)

	// Verify session WorkDir has drifted
	session, ok := sm.GetSession()
	require.True(t, ok)
	assert.Equal(t, subDir, session.WorkingDir, "session WorkDir should have drifted to subDir")

	// Set up a router with the clone handler using the INITIAL working directory
	router := gin.New()
	// The test supplies no remote URL tokens; a nil-friendly fake resolver
	// keeps the handler's nil guard unnecessary.
	tokens := NewTokenResolver(fakes.NewFakeEnvironment(nil), fakes.NewFakeProcessSpawner())
	router.POST("/api/git/clone", SessionAuthMiddleware(sm), HandleGitClone(sm, initialWorkDir, tokens))

	// Send a clone request — the URL is invalid on purpose (we only care about
	// the path resolution, not whether the clone actually succeeds). The handler
	// will attempt the clone and fail, but we can check the 409 "directory_exists"
	// behavior to verify path resolution.

	// Create a directory at initialWorkDir/repo-b to trigger the 409 response,
	// which reveals the resolved absolute path in the response body.
	repoBDir := filepath.Join(initialWorkDir, "repo-b")
	require.NoError(t, os.MkdirAll(repoBDir, 0o755))

	body := GitCloneRequest{
		URL: "https://github.com/example/repo-b.git",
	}
	jsonBody, err := json.Marshal(body)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/api/git/clone", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+sessionResp.Token)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	// We should get a 409 because repo-b exists in the INITIAL working directory.
	// If the bug were still present, the handler would look for repo-b inside
	// the drifted subDir (repo-a/repo-b), which doesn't exist, and would proceed
	// to clone — returning 200 with an SSE stream instead of 409.
	assert.Equal(t, http.StatusConflict, w.Code,
		"clone should resolve relative to initial workDir, not drifted session WorkDir. Body: %s", w.Body.String())

	var respBody map[string]interface{}
	err = json.Unmarshal(w.Body.Bytes(), &respBody)
	require.NoError(t, err)
	assert.Equal(t, "directory_exists", respBody["error"])

	// Verify the absolute path in the response points to initialWorkDir/repo-b
	// (NOT subDir/repo-b)
	assert.Equal(t, repoBDir, respBody["absolutePath"],
		"absolutePath should be relative to initial workDir")
}
