package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"

	coregithub "github.com/gruntwork-io/runbooks/core/github"
	"github.com/gruntwork-io/runbooks/core/ports"
)

// This file collects the transport-free GitHub operations shared by the
// HTTP handlers in github_auth.go / git_clone.go / github_pull_request.go
// and the IPC methods on services.GitHubService. Each function takes
// validated inputs (plus shared dependencies like ports.GitHubClient and
// SessionManager) and returns the response struct the HTTP handler would
// otherwise write back. Errors surface through the response's Error
// field rather than as Go errors so callers don't need branching error
// handling.

// =============================================================================
// Types
// =============================================================================

// GitHubListOrgsResponse wraps the orgs list plus optional error/warning.
// Mirrors the legacy handler payload: a transport-level error wipes Orgs,
// while Warning leaves the personal-account entry intact and only flags
// that org fetching failed.
type GitHubListOrgsResponse struct {
	Orgs    []GitHubOrg `json:"orgs"`
	Error   string      `json:"error,omitempty"`
	Warning string      `json:"warning,omitempty"`
}

// GitHubListReposRequest is the input for listing a single owner's repos.
type GitHubListReposRequest struct {
	Owner string `json:"owner"`
	Query string `json:"query,omitempty"`
}

// GitHubListReposResponse is the list response, mirroring the HTTP payload.
type GitHubListReposResponse struct {
	Repos []GitHubRepo `json:"repos"`
	Error string       `json:"error,omitempty"`
}

// GitHubListRefsRequest is the input for listing branches+tags in a repo.
type GitHubListRefsRequest struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
	Query string `json:"query,omitempty"`
}

// GitHubListRefsResponse mirrors the HTTP payload for list-refs.
type GitHubListRefsResponse struct {
	Refs        []GitHubRef `json:"refs"`
	TotalCount  int         `json:"totalCount,omitempty"`
	BranchCount int         `json:"branchCount,omitempty"`
	TagCount    int         `json:"tagCount,omitempty"`
	HasMore     bool        `json:"hasMore,omitempty"`
	Error       string      `json:"error,omitempty"`
}

// GitHubListLabelsRequest is the input for listing labels on a repo.
type GitHubListLabelsRequest struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
}

// GitHubLabel is the shape returned by GitHub's labels API that the UI cares about.
type GitHubLabel struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

// GitHubListLabelsResponse mirrors the HTTP payload for list-labels.
type GitHubListLabelsResponse struct {
	Labels []GitHubLabel `json:"labels"`
	Error  string        `json:"error,omitempty"`
}

// =============================================================================
// Token validation (public Op)
// =============================================================================

// ValidateGitHubToken validates a token via the domain layer (coregithub.Validate),
// which in turn uses the injected ports.GitHubClient. Empty-token handling lives
// in the caller — this Op assumes the token has been non-empty-checked by the
// transport.
func ValidateGitHubToken(ctx context.Context, gh ports.GitHubClient, req GitHubValidateRequest) GitHubValidateResponse {
	result := coregithub.Validate(ctx, gh, req.Token)
	return GitHubValidateResponse{
		Valid:     result.Valid,
		User:      githubUserInfoFromPort(result.User),
		Scopes:    result.Scopes,
		TokenType: GitHubTokenType(result.TokenType),
		Error:     result.Error,
	}
}

// =============================================================================
// OAuth device flow (public Ops)
// =============================================================================

// StartGitHubOAuth kicks off the OAuth device-authorization flow. The default
// client ID + default ("repo") scope fall back here so the UI doesn't have to
// re-embed them for each caller.
func StartGitHubOAuth(ctx context.Context, req GitHubOAuthStartRequest) GitHubOAuthStartResponse {
	clientID := req.ClientID
	if clientID == "" {
		clientID = DefaultGitHubOAuthClientID
	}
	if clientID == "" {
		return GitHubOAuthStartResponse{
			Error: "No OAuth client ID configured. Either provide oauthClientId prop or configure default client ID.",
		}
	}

	scopes := req.Scopes
	if len(scopes) == 0 {
		scopes = []string{"repo"}
	}

	resp, err := startGitHubDeviceFlow(ctx, clientID, scopes)
	if err != nil {
		return GitHubOAuthStartResponse{Error: fmt.Sprintf("Failed to start device flow: %v", err)}
	}
	return *resp
}

// PollGitHubOAuth polls for device-flow completion. Missing client ID or device
// code are surfaced through the response's Error field so both transports can
// shape them identically.
func PollGitHubOAuth(ctx context.Context, req GitHubOAuthPollRequest) GitHubOAuthPollResponse {
	if req.ClientID == "" || req.DeviceCode == "" {
		return GitHubOAuthPollResponse{
			Status: GitHubOAuthPollStatusError,
			Error:  "ClientID and DeviceCode are required",
		}
	}

	result, err := pollGitHubDeviceFlow(ctx, req.ClientID, req.DeviceCode)
	if err != nil {
		return GitHubOAuthPollResponse{
			Status: GitHubOAuthPollStatusError,
			Error:  err.Error(),
		}
	}
	return *result
}

// =============================================================================
// Environment + CLI credential confirmation (public Ops)
// =============================================================================

// ConfirmGitHubEnvCredentials reads GITHUB_TOKEN / GH_TOKEN (optionally
// prefixed) from the process environment, validates the token, and registers
// it to the session. The raw token never leaves the process — the response
// returns only user metadata + scopes + token type.
func ConfirmGitHubEnvCredentials(ctx context.Context, sessions *SessionManager, req GitHubEnvCredentialsRequest) GitHubEnvCredentialsResponse {
	if !isValidEnvVarPrefix(req.Prefix) {
		return GitHubEnvCredentialsResponse{
			Found: false,
			Error: "Invalid prefix: must be uppercase alphanumeric with underscores",
		}
	}

	githubTokenName := req.Prefix + "GITHUB_TOKEN"
	ghTokenName := req.Prefix + "GH_TOKEN"

	if !isAllowedGitHubEnvVar(githubTokenName) || !isAllowedGitHubEnvVar(ghTokenName) {
		return GitHubEnvCredentialsResponse{
			Found: false,
			Error: "Invalid prefix results in disallowed environment variable name",
		}
	}

	token := os.Getenv(githubTokenName)
	if token == "" {
		token = os.Getenv(ghTokenName)
	}
	if token == "" {
		return GitHubEnvCredentialsResponse{
			Found: false,
			Error: "GITHUB_TOKEN or GH_TOKEN not found in environment",
		}
	}

	user, scopes, err := validateGitHubToken(ctx, token)
	if err != nil {
		return GitHubEnvCredentialsResponse{
			Found: true,
			Valid: false,
			Error: fmt.Sprintf("Token found but invalid: %v", err),
		}
	}

	if err := sessions.AppendToEnv(map[string]string{
		"GITHUB_TOKEN": token,
		"GITHUB_USER":  user.Login,
	}); err != nil {
		return GitHubEnvCredentialsResponse{
			Found: true,
			Valid: true,
			Error: "Failed to register credentials to session",
		}
	}

	return GitHubEnvCredentialsResponse{
		Found:     true,
		Valid:     true,
		User:      user,
		Scopes:    scopes,
		TokenType: detectGitHubTokenType(token),
	}
}

// ConfirmGitHubCliCredentials shells out to `gh auth token` / `gh auth status`,
// validates the returned token, and registers it to the session. Only safe
// metadata (user + scopes) is returned — the raw token stays process-local.
func ConfirmGitHubCliCredentials(ctx context.Context, sessions *SessionManager) GitHubCliCredentialsResponse {
	ghPath, err := exec.LookPath("gh")
	if err != nil {
		return GitHubCliCredentialsResponse{
			Error: "GitHub CLI (gh) is not installed",
		}
	}

	tokenOutput, err := exec.CommandContext(ctx, ghPath, "auth", "token").Output()
	if err != nil {
		return GitHubCliCredentialsResponse{
			Error: "Not authenticated to GitHub CLI. Run 'gh auth login' to authenticate.",
		}
	}
	token := strings.TrimSpace(string(tokenOutput))
	if token == "" {
		return GitHubCliCredentialsResponse{
			Error: "GitHub CLI returned empty token",
		}
	}

	user, _, err := validateGitHubToken(ctx, token)
	if err != nil {
		return GitHubCliCredentialsResponse{
			Error: fmt.Sprintf("GitHub CLI token is invalid: %v", err),
		}
	}

	// `gh auth status` is parsed independently of the GitHub API response
	// because the X-OAuth-Scopes header doesn't reflect the CLI's actual
	// granted scopes in every case.
	statusOutput, _ := exec.CommandContext(ctx, ghPath, "auth", "status").CombinedOutput()
	scopes := parseGitHubCliScopes(string(statusOutput))

	if err := sessions.AppendToEnv(map[string]string{
		"GITHUB_TOKEN": token,
		"GITHUB_USER":  user.Login,
	}); err != nil {
		return GitHubCliCredentialsResponse{
			Error: "Failed to register credentials to session",
		}
	}

	return GitHubCliCredentialsResponse{
		User:   user,
		Scopes: scopes,
	}
}

// =============================================================================
// List Ops (public)
// =============================================================================

// ListGitHubOrgs returns the authenticated user's orgs plus a synthetic entry
// for their personal account. A transport-level failure on the /user call
// wipes the whole list; a failure only on /user/orgs keeps the personal
// account entry and surfaces Warning so the UI can still render it.
func ListGitHubOrgs(ctx context.Context, sessions *SessionManager) GitHubListOrgsResponse {
	token := getGitHubTokenFromSession(sessions)
	if token == "" {
		return GitHubListOrgsResponse{Orgs: []GitHubOrg{}, Error: "No GitHub token found in session"}
	}

	user, _, err := validateGitHubToken(ctx, token)
	if err != nil {
		return GitHubListOrgsResponse{Orgs: []GitHubOrg{}, Error: fmt.Sprintf("Failed to validate token: %v", err)}
	}

	orgs := []GitHubOrg{
		{Login: user.Login, AvatarURL: user.AvatarURL, Type: "User"},
	}

	ghOrgs, err := fetchGitHubOrgs(ctx, token)
	if err != nil {
		return GitHubListOrgsResponse{Orgs: orgs, Warning: fmt.Sprintf("Failed to list organizations: %v", err)}
	}
	orgs = append(orgs, ghOrgs...)
	return GitHubListOrgsResponse{Orgs: orgs}
}

// ListGitHubRepos returns repositories for the given owner (user or org). An
// optional query filters via GitHub's search API; empty query falls back to
// the plain list endpoint sorted by recent update.
func ListGitHubRepos(ctx context.Context, sessions *SessionManager, req GitHubListReposRequest) GitHubListReposResponse {
	if req.Owner == "" {
		return GitHubListReposResponse{Repos: []GitHubRepo{}, Error: "owner is required"}
	}
	if !isValidGitHubOwner(req.Owner) {
		return GitHubListReposResponse{Repos: []GitHubRepo{}, Error: "Invalid owner name"}
	}

	token := getGitHubTokenFromSession(sessions)
	if token == "" {
		return GitHubListReposResponse{Repos: []GitHubRepo{}, Error: "No GitHub token found in session"}
	}

	repos, err := fetchGitHubRepos(ctx, token, req.Owner, req.Query)
	if err != nil {
		return GitHubListReposResponse{Repos: []GitHubRepo{}, Error: fmt.Sprintf("Failed to list repositories: %v", err)}
	}
	return GitHubListReposResponse{Repos: repos}
}

// ListGitHubRefs returns branches+tags for a repo. Branches are fetched and
// sorted with the default branch first; tags follow. Both lists are capped at
// three pages of 100 (see fetchGitHubBranches / fetchGitHubTags).
func ListGitHubRefs(ctx context.Context, sessions *SessionManager, req GitHubListRefsRequest) GitHubListRefsResponse {
	if req.Owner == "" || req.Repo == "" {
		return GitHubListRefsResponse{Refs: []GitHubRef{}, Error: "owner and repo are required"}
	}
	if !isValidGitHubOwner(req.Owner) {
		return GitHubListRefsResponse{Refs: []GitHubRef{}, Error: "Invalid owner name"}
	}
	if !isValidGitHubRepoName(req.Repo) {
		return GitHubListRefsResponse{Refs: []GitHubRef{}, Error: "Invalid repository name"}
	}

	token := getGitHubTokenFromSession(sessions)
	if token == "" {
		return GitHubListRefsResponse{Refs: []GitHubRef{}, Error: "No GitHub token found in session"}
	}

	branches, branchTotal, branchErr := fetchGitHubBranches(ctx, token, req.Owner, req.Repo, req.Query)
	tags, tagTotal, tagErr := fetchGitHubTags(ctx, token, req.Owner, req.Repo, req.Query)
	if branchErr != nil && tagErr != nil {
		return GitHubListRefsResponse{
			Refs:  []GitHubRef{},
			Error: fmt.Sprintf("Failed to fetch refs: %v; %v", branchErr, tagErr),
		}
	}

	var refs []GitHubRef
	for _, b := range branches {
		refs = append(refs, GitHubRef{
			Name:            b.Name,
			Type:            "branch",
			IsDefaultBranch: b.IsDefault,
		})
	}
	refs = append(refs, tags...)

	return GitHubListRefsResponse{
		Refs:        refs,
		TotalCount:  branchTotal + tagTotal,
		BranchCount: branchTotal,
		TagCount:    tagTotal,
		HasMore:     branchTotal > len(branches) || tagTotal > len(tags),
	}
}

// ListGitHubLabels returns labels for the given repo. Matches the legacy
// handler's "always 200, error in body" shape so the UI treats missing-token
// and transport failures the same way.
func ListGitHubLabels(ctx context.Context, sessions *SessionManager, req GitHubListLabelsRequest) GitHubListLabelsResponse {
	if req.Owner == "" || req.Repo == "" {
		return GitHubListLabelsResponse{Labels: []GitHubLabel{}, Error: "owner and repo are required"}
	}
	if !isValidGitHubOwner(req.Owner) {
		return GitHubListLabelsResponse{Labels: []GitHubLabel{}, Error: "Invalid owner name"}
	}
	if !isValidGitHubRepoName(req.Repo) {
		return GitHubListLabelsResponse{Labels: []GitHubLabel{}, Error: "Invalid repository name"}
	}

	token := getGitHubTokenFromSession(sessions)
	if token == "" {
		return GitHubListLabelsResponse{Labels: []GitHubLabel{}, Error: "No GitHub token found in session"}
	}

	apiURL := fmt.Sprintf("%s/repos/%s/%s/labels?per_page=100",
		GitHubAPIBaseURL, url.PathEscape(req.Owner), url.PathEscape(req.Repo))

	resp, err := doGitHubAPIGet(ctx, token, apiURL)
	if err != nil {
		return GitHubListLabelsResponse{Labels: []GitHubLabel{}, Error: fmt.Sprintf("Failed to fetch labels: %v", err)}
	}
	defer resp.Body.Close()

	var rawLabels []GitHubLabel
	if err := json.NewDecoder(resp.Body).Decode(&rawLabels); err != nil {
		return GitHubListLabelsResponse{Labels: []GitHubLabel{}, Error: "Failed to parse labels response"}
	}

	return GitHubListLabelsResponse{Labels: rawLabels}
}
