package services

import (
	"context"
	"fmt"
	"time"

	"github.com/gruntwork-io/runbooks/api"
	"github.com/gruntwork-io/runbooks/core/ports"
)

// GitHubService is the Wails IPC wrapper around the GitHub handlers in
// the legacy Gin server. Every method corresponds 1:1 to a
// /api/github/* endpoint so migrating the frontend hooks is a
// per-method drop-in replacement.
//
// Validate uses the GitHubClient port so it stays testable with a fake
// adapter. The OAuth / list / credential-detection helpers still reach
// the GitHub REST API directly via api.doGitHubAPIGet / doGitHubAPIPost
// — the v1 desktop adapter already does that work in-process, and a
// future hosted adapter can replace the whole surface by swapping this
// service for one that talks to a tenant-scoped GitHub port.
//
// Git-filesystem operations (clone, push, delete-branch) and the
// streaming PR-creation flow are not exposed here; they belong to
// GitService (task #43) because they orchestrate the `git` binary
// rather than the GitHub REST API.
type GitHubService struct {
	servers *serverManager
	github  ports.GitHubClient
}

// NewGitHubService constructs the GitHub service. The GitHubClient port
// is injected so tests can substitute a fake, and so a future hosted
// composition root can plug in a tenant-scoped adapter.
func NewGitHubService(servers *serverManager, github ports.GitHubClient) *GitHubService {
	return &GitHubService{servers: servers, github: github}
}

// ServiceName satisfies application.ServiceName.
func (s *GitHubService) ServiceName() string { return "GitHubService" }

// githubIPCTimeout matches the 10s deadline the HTTP handlers use for
// token validation and OAuth round trips.
const githubIPCTimeout = 10 * time.Second

// githubIPCListTimeout matches the 15s deadline the HTTP list handlers
// use for branches/tags/labels calls (slower than a single-GET token
// validation because they may paginate).
const githubIPCListTimeout = 15 * time.Second

// Validate validates a GitHub token via the GitHubClient port. Matches
// the legacy /api/github/validate HTTP handler.
func (s *GitHubService) Validate(req api.GitHubValidateRequest) (*api.GitHubValidateResponse, error) {
	if req.Token == "" {
		return &api.GitHubValidateResponse{Valid: false, Error: "Token is required"}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), githubIPCTimeout)
	defer cancel()
	resp := api.ValidateGitHubToken(ctx, s.github, req)
	return &resp, nil
}

// OAuthStart initiates the GitHub OAuth device-authorization flow. The
// UI uses the returned VerificationURI + UserCode to launch the browser
// and then polls OAuthPoll until the user completes the flow.
func (s *GitHubService) OAuthStart(req api.GitHubOAuthStartRequest) (*api.GitHubOAuthStartResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), githubIPCTimeout)
	defer cancel()
	resp := api.StartGitHubOAuth(ctx, req)
	return &resp, nil
}

// OAuthPoll polls for OAuth completion. Status drives the UI state
// machine (pending / complete / expired / error).
func (s *GitHubService) OAuthPoll(req api.GitHubOAuthPollRequest) (*api.GitHubOAuthPollResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), githubIPCTimeout)
	defer cancel()
	resp := api.PollGitHubOAuth(ctx, req)
	return &resp, nil
}

// EnvCredentials reads (prefixed) GitHub credentials from the process
// environment, validates them, and registers them to the open
// gruntbook's session. Returns only user metadata + scopes — the raw
// token never leaves the process. Matches the legacy
// /api/github/env-credentials endpoint.
func (s *GitHubService) EnvCredentials(req api.GitHubEnvCredentialsRequest) (*api.GitHubEnvCredentialsResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	ctx, cancel := context.WithTimeout(context.Background(), githubIPCTimeout)
	defer cancel()
	resp := api.ConfirmGitHubEnvCredentials(ctx, sessions, req)
	return &resp, nil
}

// CliCredentials detects GitHub credentials from the `gh` CLI, validates
// them, and registers them to the open gruntbook's session. Returns only
// user metadata + scopes. Matches the legacy /api/github/cli-credentials
// endpoint.
func (s *GitHubService) CliCredentials() (*api.GitHubCliCredentialsResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	ctx, cancel := context.WithTimeout(context.Background(), githubIPCTimeout)
	defer cancel()
	resp := api.ConfirmGitHubCliCredentials(ctx, sessions)
	return &resp, nil
}

// ListOrgs returns the authenticated user's organizations plus their
// personal account. Requires an open gruntbook so the session token is
// available. Matches /api/github/orgs.
func (s *GitHubService) ListOrgs() (*api.GitHubListOrgsResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	ctx, cancel := context.WithTimeout(context.Background(), githubIPCListTimeout)
	defer cancel()
	resp := api.ListGitHubOrgs(ctx, sessions)
	return &resp, nil
}

// ListRepos returns repositories for the given owner, optionally
// filtered by query. Matches /api/github/repos.
func (s *GitHubService) ListRepos(req api.GitHubListReposRequest) (*api.GitHubListReposResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	ctx, cancel := context.WithTimeout(context.Background(), githubIPCListTimeout)
	defer cancel()
	resp := api.ListGitHubRepos(ctx, sessions, req)
	return &resp, nil
}

// ListRefs returns branches and tags for a given owner/repo, optionally
// filtered by query. Branches are sorted default-first. Matches
// /api/github/refs.
func (s *GitHubService) ListRefs(req api.GitHubListRefsRequest) (*api.GitHubListRefsResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	ctx, cancel := context.WithTimeout(context.Background(), githubIPCListTimeout)
	defer cancel()
	resp := api.ListGitHubRefs(ctx, sessions, req)
	return &resp, nil
}

// ListLabels returns labels for a given owner/repo. Matches
// /api/github/labels.
func (s *GitHubService) ListLabels(req api.GitHubListLabelsRequest) (*api.GitHubListLabelsResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	ctx, cancel := context.WithTimeout(context.Background(), githubIPCListTimeout)
	defer cancel()
	resp := api.ListGitHubLabels(ctx, sessions, req)
	return &resp, nil
}
