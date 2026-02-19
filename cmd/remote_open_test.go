package cmd

import (
	"fmt"
	"testing"

	"runbooks/api"

	"github.com/spf13/cobra"
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
		{"unknown host returns empty hints", "bitbucket.org", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tokenVar, cliCmd := api.AuthHintForHost(tt.host)
			assert.Equal(t, tt.expectedVar, tokenVar)
			assert.Equal(t, tt.expectedCmd, cliCmd)
		})
	}
}

func TestResolveRemoteSource(t *testing.T) {
	t.Run("local path passes through unchanged", func(t *testing.T) {
		localPath, cleanup, isRemote, remoteURL, err := resolveRemoteSource("./my-runbook")
		assert.NoError(t, err)
		assert.Equal(t, "./my-runbook", localPath)
		assert.Nil(t, cleanup)
		assert.False(t, isRemote)
		assert.Empty(t, remoteURL)
	})

	t.Run("absolute path passes through unchanged", func(t *testing.T) {
		localPath, cleanup, isRemote, remoteURL, err := resolveRemoteSource("/home/user/runbook")
		assert.NoError(t, err)
		assert.Equal(t, "/home/user/runbook", localPath)
		assert.Nil(t, cleanup)
		assert.False(t, isRemote)
		assert.Empty(t, remoteURL)
	})

	t.Run("invalid remote URL returns error", func(t *testing.T) {
		_, _, _, _, err := resolveRemoteSource("https://github.com/only-owner")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "invalid remote source")
	})
}

func TestValidateSourceArg(t *testing.T) {
	t.Run("no args returns error", func(t *testing.T) {
		cmd := &cobra.Command{Use: "open"}
		err := validateSourceArg(cmd, []string{})
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "missing required argument")
	})

	t.Run("one arg succeeds", func(t *testing.T) {
		cmd := &cobra.Command{Use: "open"}
		err := validateSourceArg(cmd, []string{"./my-runbook"})
		assert.NoError(t, err)
	})

	t.Run("multiple args returns error", func(t *testing.T) {
		cmd := &cobra.Command{Use: "open"}
		err := validateSourceArg(cmd, []string{"a", "b"})
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "expected 1 argument")
	})
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
