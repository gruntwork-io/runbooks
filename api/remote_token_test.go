package api

import (
	"testing"

	"github.com/gruntwork-io/runbooks/core/ports"
	"github.com/gruntwork-io/runbooks/core/ports/fakes"

	"github.com/stretchr/testify/assert"
)

func newTestResolver(env map[string]string) *TokenResolver {
	return NewTokenResolver(fakes.NewFakeEnvironment(env), fakes.NewFakeProcessSpawner())
}

func TestTokenResolver_GitHubEnvVars(t *testing.T) {
	// GITHUB_TOKEN takes precedence over GH_TOKEN
	r := newTestResolver(map[string]string{
		"GITHUB_TOKEN": "gh-token-1",
		"GH_TOKEN":     "gh-token-2",
	})

	assert.Equal(t, "gh-token-1", r.TokenForHost("github.com"))
}

func TestTokenResolver_GitHubFallsBackToGHToken(t *testing.T) {
	// When GITHUB_TOKEN is unset or empty, GH_TOKEN is used
	r := newTestResolver(map[string]string{
		"GH_TOKEN": "gh-token-2",
	})

	assert.Equal(t, "gh-token-2", r.TokenForHost("github.com"))
}

func TestTokenResolver_GitLabEnvVar(t *testing.T) {
	r := newTestResolver(map[string]string{
		"GITLAB_TOKEN": "gl-token-1",
	})

	assert.Equal(t, "gl-token-1", r.TokenForHost("gitlab.com"))
}

func TestTokenResolver_CaseInsensitive(t *testing.T) {
	r := newTestResolver(map[string]string{
		"GITHUB_TOKEN": "gh-token",
		"GITLAB_TOKEN": "gl-token",
	})

	assert.Equal(t, "gh-token", r.TokenForHost("GitHub.com"))
	assert.Equal(t, "gh-token", r.TokenForHost("GITHUB.COM"))
	assert.Equal(t, "gl-token", r.TokenForHost("GitLab.com"))
	assert.Equal(t, "gl-token", r.TokenForHost("GITLAB.COM"))
}

func TestTokenResolver_UnknownHost(t *testing.T) {
	r := newTestResolver(nil)

	assert.Equal(t, "", r.TokenForHost("bitbucket.org"))
}

func TestTokenResolver_FallsBackToCLIWhenEnvMissing(t *testing.T) {
	env := fakes.NewFakeEnvironment(nil)
	spawner := fakes.NewFakeProcessSpawner()
	spawner.SetLookPath("gh", "/usr/local/bin/gh")
	spawner.QueueRun(ports.ProcessResult{Stdout: []byte("gh-cli-token\n")}, nil)

	r := NewTokenResolver(env, spawner)

	assert.Equal(t, "gh-cli-token", r.TokenForHost("github.com"))

	// Second call should hit the cache (no new scripted response queued).
	assert.Equal(t, "gh-cli-token", r.TokenForHost("github.com"))
}

func TestTokenResolver_EmptyWhenCLINotFoundAndNoEnv(t *testing.T) {
	r := newTestResolver(nil) // spawner has no LookPath entries, so gh is "not found"

	assert.Empty(t, r.TokenForHost("github.com"))
	assert.Empty(t, r.TokenForHost("gitlab.com"))
}
