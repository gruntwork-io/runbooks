package api

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// GetTokenForHost returns an auth token for the given git host.
// For github.com: checks GITHUB_TOKEN → GH_TOKEN → `gh auth token` (5s timeout)
// For gitlab.com: checks GITLAB_TOKEN → `glab auth token` (5s timeout)
// Returns empty string if no token is found (not an error — repo may be public).
//
// The token is only used in-memory for authenticating git operations.
// It is never written to disk, logged, or included in error messages.
func GetTokenForHost(host string) string {
	switch strings.ToLower(host) {
	case "github.com":
		return getGitHubTokenFromEnv()
	case "gitlab.com":
		return getGitLabTokenFromEnv()
	default:
		return ""
	}
}

// getGitHubTokenFromEnv checks GITHUB_TOKEN, GH_TOKEN env vars,
// then falls back to `gh auth token` CLI.
func getGitHubTokenFromEnv() string {
	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		return token
	}
	if token := os.Getenv("GH_TOKEN"); token != "" {
		return token
	}
	return tokenFromCLI("gh", "auth", "token")
}

// getGitLabTokenFromEnv checks GITLAB_TOKEN env var,
// then falls back to `glab auth token` CLI.
func getGitLabTokenFromEnv() string {
	if token := os.Getenv("GITLAB_TOKEN"); token != "" {
		return token
	}
	return tokenFromCLI("glab", "auth", "token")
}

// tokenFromCLI runs a CLI command and returns the trimmed stdout output.
// Returns empty string if the command is not found, fails, or returns empty output.
func tokenFromCLI(name string, args ...string) string {
	path, err := exec.LookPath(name)
	if err != nil {
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, path, args...)
	output, err := cmd.Output()
	if err != nil {
		return ""
	}

	return strings.TrimSpace(string(output))
}
