package api

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// TokenResolver looks up auth tokens for git hosts, consulting environment
// variables first and then falling back to host-specific CLI tools
// (`gh auth token`, `glab auth token`). Results are cached per-resolver so
// repeated lookups for the same CLI don't re-spawn the process.
//
// The resolver depends on the Environment and ProcessSpawner ports so the
// same logic works against the real host environment (desktop) and against
// tenant-scoped adapters (future hosted service) without modification.
type TokenResolver struct {
	env     ports.Environment
	spawner ports.ProcessSpawner

	mu    sync.Mutex
	cache map[string]string
}

// NewTokenResolver returns a TokenResolver backed by the given ports.
func NewTokenResolver(env ports.Environment, spawner ports.ProcessSpawner) *TokenResolver {
	return &TokenResolver{
		env:     env,
		spawner: spawner,
		cache:   make(map[string]string),
	}
}

// TokenForHost returns an auth token for the given git host.
//
//	github.com → GITHUB_TOKEN → GH_TOKEN → `gh auth token` (5s timeout)
//	gitlab.com → GITLAB_TOKEN → `glab auth token` (5s timeout)
//
// Returns "" if no token is found (not an error — the repo may be public).
// The returned token is only used in-memory for authenticating git
// operations; it is never written to disk, logged, or included in error
// messages.
func (r *TokenResolver) TokenForHost(host string) string {
	switch strings.ToLower(host) {
	case "github.com":
		return r.githubTokenFromEnv()
	case "gitlab.com":
		return r.gitlabTokenFromEnv()
	default:
		return ""
	}
}

func (r *TokenResolver) githubTokenFromEnv() string {
	if token, ok := r.env.Get("GITHUB_TOKEN"); ok && token != "" {
		return token
	}
	if token, ok := r.env.Get("GH_TOKEN"); ok && token != "" {
		return token
	}
	return r.tokenFromCLI("gh", "auth", "token")
}

func (r *TokenResolver) gitlabTokenFromEnv() string {
	if token, ok := r.env.Get("GITLAB_TOKEN"); ok && token != "" {
		return token
	}
	return r.tokenFromCLI("glab", "auth", "token")
}

// tokenFromCLI runs a CLI command via the ProcessSpawner port and returns
// the trimmed stdout output. Results are cached per-resolver. Returns ""
// if the command is not found, fails, or returns empty output.
func (r *TokenResolver) tokenFromCLI(name string, args ...string) string {
	key := name + " " + strings.Join(args, " ")

	r.mu.Lock()
	if cached, ok := r.cache[key]; ok {
		r.mu.Unlock()
		return cached
	}
	r.mu.Unlock()

	path, err := r.spawner.LookPath(name)
	if err != nil {
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := r.spawner.Run(ctx, ports.ProcessRequest{
		Name: path,
		Args: args,
	})
	if err != nil || result.ExitCode != 0 {
		return ""
	}

	token := strings.TrimSpace(string(result.Stdout))

	r.mu.Lock()
	r.cache[key] = token
	r.mu.Unlock()

	return token
}

// AuthHintForHost returns the environment variable name and CLI command
// that a user should use to authenticate with the given git host.
// Returns empty strings for unknown hosts. This is pure metadata and
// doesn't need any ports.
func AuthHintForHost(host string) (tokenVar, cliCmd string) {
	switch strings.ToLower(host) {
	case "github.com":
		return "GITHUB_TOKEN", "gh auth login"
	case "gitlab.com":
		return "GITLAB_TOKEN", "glab auth login"
	default:
		return "", ""
	}
}
