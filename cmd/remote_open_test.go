package cmd

import (
	"fmt"
	"testing"

	"runbooks/api"

	"github.com/stretchr/testify/assert"
)

func TestIsAuthError(t *testing.T) {
	tests := []struct {
		name     string
		msg      string
		expected bool
	}{
		{"authentication failed", "fatal: Authentication failed for 'https://...'", true},
		{"could not read username", "fatal: could not read Username for 'https://github.com': terminal prompts disabled", true},
		{"http 404", "fatal: repository 'https://github.com/...' not found (HTTP 404)", true},
		{"repository not found", "remote: Repository not found.", true},
		{"fatal could not read", "fatal: could not read from remote repository", true},
		{"403 forbidden", "The requested URL returned error: 403", true},
		{"normal git error", "fatal: not a git repository", false},
		{"empty string", "", false},
		{"timeout error", "fatal: unable to access: connection timed out", false},
		{"case insensitive", "AUTHENTICATION FAILED", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, isAuthError(tt.msg))
		})
	}
}

func TestAuthHintForHost(t *testing.T) {
	tests := []struct {
		name        string
		host        string
		expectedVar string
		expectedCmd string
	}{
		{"GitHub", "github.com", "GITHUB_TOKEN", "gh auth login"},
		{"GitLab", "gitlab.com", "GITLAB_TOKEN", "glab auth login"},
		{"GitHub uppercase", "GitHub.com", "GITHUB_TOKEN", "gh auth login"},
		{"GitLab uppercase", "GitLab.com", "GITLAB_TOKEN", "glab auth login"},
		{"unknown host defaults to GitHub", "bitbucket.org", "GITHUB_TOKEN", "gh auth login"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tokenVar, cliCmd := api.AuthHintForHost(tt.host)
			assert.Equal(t, tt.expectedVar, tokenVar)
			assert.Equal(t, tt.expectedCmd, cliCmd)
		})
	}
}

func TestClassifyCloneError(t *testing.T) {
	t.Run("auth error without token gives auth hint", func(t *testing.T) {
		parsed := &api.ParsedRemoteSource{
			Host: "github.com", Owner: "org", Repo: "repo",
			CloneURL: "https://github.com/org/repo.git",
		}
		err := classifyCloneError(
			fmt.Errorf("exit status 128"),
			[]byte("fatal: Authentication failed for 'https://github.com/org/repo.git'"),
			"", // no token
			parsed,
		)
		assert.Contains(t, err.Error(), "GITHUB_TOKEN")
		assert.Contains(t, err.Error(), "gh auth login")
		assert.Contains(t, err.Error(), "github.com/org/repo")
	})

	t.Run("auth error with token suggests token may be expired", func(t *testing.T) {
		parsed := &api.ParsedRemoteSource{
			Host: "github.com", Owner: "org", Repo: "repo",
			CloneURL: "https://github.com/org/repo.git",
		}
		err := classifyCloneError(
			fmt.Errorf("exit status 128"),
			[]byte("fatal: Authentication failed"),
			"ghp_sometoken",
			parsed,
		)
		assert.Contains(t, err.Error(), "authentication failed")
		assert.Contains(t, err.Error(), "invalid or expired")
		assert.Contains(t, err.Error(), "GITHUB_TOKEN")
		assert.Contains(t, err.Error(), "gh auth login")
		assert.Contains(t, err.Error(), "github.com/org/repo")
	})

	t.Run("non-auth error gives generic message", func(t *testing.T) {
		parsed := &api.ParsedRemoteSource{
			Host: "github.com", Owner: "org", Repo: "repo",
			CloneURL: "https://github.com/org/repo.git",
		}
		err := classifyCloneError(
			fmt.Errorf("exit status 128"),
			[]byte("fatal: not a git repository"),
			"",
			parsed,
		)
		assert.Contains(t, err.Error(), "failed to download")
		assert.NotContains(t, err.Error(), "GITHUB_TOKEN")
	})

	t.Run("GitLab auth error gives GitLab hint", func(t *testing.T) {
		parsed := &api.ParsedRemoteSource{
			Host: "gitlab.com", Owner: "myorg", Repo: "myrepo",
			CloneURL: "https://gitlab.com/myorg/myrepo.git",
		}
		err := classifyCloneError(
			fmt.Errorf("exit status 128"),
			[]byte("remote: Repository not found."),
			"",
			parsed,
		)
		assert.Contains(t, err.Error(), "GITLAB_TOKEN")
		assert.Contains(t, err.Error(), "glab auth login")
	})

	t.Run("nil output is handled", func(t *testing.T) {
		parsed := &api.ParsedRemoteSource{
			Host: "github.com", Owner: "org", Repo: "repo",
			CloneURL: "https://github.com/org/repo.git",
		}
		err := classifyCloneError(
			fmt.Errorf("some error"),
			nil,
			"",
			parsed,
		)
		assert.Contains(t, err.Error(), "failed to download")
	})
}
