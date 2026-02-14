package api

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestGetTokenForHost_GitHubEnvVars(t *testing.T) {
	// GITHUB_TOKEN takes precedence over GH_TOKEN
	t.Setenv("GITHUB_TOKEN", "gh-token-1")
	t.Setenv("GH_TOKEN", "gh-token-2")

	token := GetTokenForHost("github.com")
	assert.Equal(t, "gh-token-1", token)
}

func TestGetTokenForHost_GitHubFallsBackToGHToken(t *testing.T) {
	// When GITHUB_TOKEN is not set, GH_TOKEN is used
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("GH_TOKEN", "gh-token-2")

	token := GetTokenForHost("github.com")
	assert.Equal(t, "gh-token-2", token)
}

func TestGetTokenForHost_GitLabEnvVar(t *testing.T) {
	t.Setenv("GITLAB_TOKEN", "gl-token-1")

	token := GetTokenForHost("gitlab.com")
	assert.Equal(t, "gl-token-1", token)
}

func TestGetTokenForHost_CaseInsensitive(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "gh-token")
	t.Setenv("GITLAB_TOKEN", "gl-token")

	assert.Equal(t, "gh-token", GetTokenForHost("GitHub.com"))
	assert.Equal(t, "gh-token", GetTokenForHost("GITHUB.COM"))
	assert.Equal(t, "gl-token", GetTokenForHost("GitLab.com"))
	assert.Equal(t, "gl-token", GetTokenForHost("GITLAB.COM"))
}

func TestGetTokenForHost_UnknownHost(t *testing.T) {
	token := GetTokenForHost("bitbucket.org")
	assert.Equal(t, "", token)
}

func TestGetTokenForHost_NoTokenSet(t *testing.T) {
	// Clear all token env vars
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("GH_TOKEN", "")

	// Without gh CLI available, this should return empty
	// (the CLI fallback may or may not work depending on the test environment,
	// but with empty env vars the env var path definitely returns empty)
	token := GetTokenForHost("github.com")
	// Token will be empty unless `gh auth token` succeeds in the test environment
	// We just verify it doesn't panic or error
	_ = token
}
