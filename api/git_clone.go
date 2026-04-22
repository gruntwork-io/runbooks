package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// Pre-compiled regex patterns
var (
	sshURLPattern          = regexp.MustCompile(`^[\w.-]+@[\w.-]+:[\w./-]+$`)
	gitHubOwnerPattern     = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$`)
	gitHubRepoNamePattern  = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	tokenSanitizePattern   = regexp.MustCompile(`(?:x-access-token|oauth2):[^@]+@`)
)

// =============================================================================
// Types
// =============================================================================

// GitHubOrg represents a GitHub organization or user account
type GitHubOrg struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
	Type      string `json:"type"` // "Organization" or "User"
}

// GitHubRepo represents a GitHub repository
type GitHubRepo struct {
	Name        string `json:"name"`
	FullName    string `json:"fullName"`
	Private     bool   `json:"private"`
	Description string `json:"description"`
}

// GitHubRef represents a git ref (branch or tag) in a GitHub repository.
type GitHubRef struct {
	Name            string `json:"name"`
	Type            string `json:"type"`            // "branch" or "tag"
	IsDefaultBranch bool   `json:"isDefaultBranch"` // true only for the default branch
}

// GitCloneRequest represents the request body for POST /api/git/clone
type GitCloneRequest struct {
	URL       string `json:"url"`
	Ref       string `json:"ref,omitempty"`        // Branch or tag to clone (uses --branch flag)
	RepoPath  string `json:"repo_path,omitempty"`
	LocalPath string `json:"local_path,omitempty"`
	UsePTY    *bool  `json:"use_pty,omitempty"` // Whether to use PTY for execution (default: true)
	Force     bool   `json:"force,omitempty"`   // If true, delete existing destination directory before cloning
}

// GitCloneResultEvent is sent as an SSE event on successful clone
type GitCloneResultEvent struct {
	FileCount    int    `json:"fileCount"`
	AbsolutePath string `json:"absolutePath"`
	RelativePath string `json:"relativePath"`
}

// =============================================================================
// GitHub API Handlers
// =============================================================================

// HandleGitHubListOrgs returns the authenticated user's organizations plus
// their personal account. Thin shell over ListGitHubOrgs (see github_ops.go).
// GET /api/github/orgs. Requires SessionAuthMiddleware.
func HandleGitHubListOrgs(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		c.JSON(http.StatusOK, ListGitHubOrgs(ctx, sm))
	}
}

// HandleGitHubListRepos returns repositories for a given owner. Thin shell
// over ListGitHubRepos (see github_ops.go).
// GET /api/github/repos?owner=<owner>&query=<optional search>. Requires
// SessionAuthMiddleware.
func HandleGitHubListRepos(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		c.JSON(http.StatusOK, ListGitHubRepos(ctx, sm, GitHubListReposRequest{
			Owner: c.Query("owner"),
			Query: c.Query("query"),
		}))
	}
}

// HandleGitHubListRefs returns branches and tags for a given owner/repo.
// Thin shell over ListGitHubRefs (see github_ops.go).
// GET /api/github/refs?owner=<owner>&repo=<repo>&query=<optional search>.
// Requires SessionAuthMiddleware.
func HandleGitHubListRefs(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		c.JSON(http.StatusOK, ListGitHubRefs(ctx, sm, GitHubListRefsRequest{
			Owner: c.Query("owner"),
			Repo:  c.Query("repo"),
			Query: c.Query("query"),
		}))
	}
}

// =============================================================================
// Git Clone Plan + Prepare
// =============================================================================

// GitClonePlan is the validated, ready-to-run form of a GitCloneRequest.
// PrepareGitClone produces one from a raw request; StreamGitClone
// consumes it. Splitting the flow this way lets the IPC path surface
// validation failures synchronously as return values while the HTTP
// path maps them to status codes.
type GitClonePlan struct {
	// CloneURL is the original request URL with any available git auth
	// token injected (so downstream git invocations can authenticate).
	CloneURL string
	// RepoURL is the original URL the user supplied, kept for outputs.
	RepoURL string
	// AbsolutePath is the on-disk clone destination.
	AbsolutePath string
	// RelativePath is AbsolutePath relative to the server's working
	// directory, used in log messages and outputs.
	RelativePath string
	// Ref is the branch or tag to clone (empty = default).
	Ref string
	// RepoPath is the subtree for sparse checkout (empty = full clone).
	RepoPath string
	// UsePTY is whether to use a PTY when invoking git (defaults on).
	UsePTY bool
}

// GitCloneError is the shaped pre-flight failure a Prepare step can
// return. Code distinguishes the different transport-level responses
// the frontend needs to branch on (in particular directory_exists →
// "confirm overwrite?" dialog).
type GitCloneError struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	Path         string `json:"path,omitempty"`
	AbsolutePath string `json:"absolutePath,omitempty"`
}

// Error implements the error interface so GitCloneError can be returned
// alongside or instead of a plan without requiring a separate return
// slot for the Go side.
func (e *GitCloneError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

// Git clone error codes. Kept in sync with the legacy HTTP shape so the
// frontend doesn't have to branch on transport.
const (
	GitCloneErrInvalidRequest  = "invalid_request"
	GitCloneErrInvalidURL      = "invalid_url"
	GitCloneErrNoSession       = "no_session"
	GitCloneErrPathOutside     = "path_outside_working_dir"
	GitCloneErrPathResolve     = "path_resolve_failed"
	GitCloneErrDirectoryExists = "directory_exists"
	GitCloneErrDeleteFailed    = "delete_failed"
)

// PrepareGitClone validates a clone request and resolves the on-disk
// destination against the server's working directory. When Force is
// false and the destination already exists, returns a GitCloneError
// with Code=directory_exists so the caller can prompt the user; when
// Force is true, attempts to remove the existing path up front.
//
// sessionPresent is the caller's answer to "does a session exist?" —
// the HTTP path gets this from middleware, the IPC path from the
// session manager. Keeping it a parameter means this function stays
// transport-free.
func PrepareGitClone(req GitCloneRequest, workingDir string, tokens *TokenResolver, sessionPresent bool) (*GitClonePlan, *GitCloneError) {
	if req.URL == "" {
		return nil, &GitCloneError{Code: GitCloneErrInvalidRequest, Message: "url is required"}
	}
	if !isValidGitURL(req.URL) {
		return nil, &GitCloneError{Code: GitCloneErrInvalidURL, Message: "Invalid git URL format"}
	}
	if !sessionPresent {
		return nil, &GitCloneError{Code: GitCloneErrNoSession, Message: "Session context not found"}
	}

	// Always resolve clone paths relative to the initial working directory
	// (the --working-dir passed at server start), NOT the session's current
	// working directory. The session WorkDir can drift when <Command> blocks
	// execute scripts that change directory (e.g. `cd infra-catalog`), which
	// would cause a second <GitClone> to nest inside the first clone's tree.
	absolutePath, relativePath := ResolveClonePaths(req.LocalPath, req.URL, workingDir)

	absWorkDir, err := filepath.Abs(workingDir)
	if err != nil {
		return nil, &GitCloneError{Code: GitCloneErrPathResolve, Message: "Failed to resolve working directory"}
	}
	absClonePath, err := filepath.Abs(absolutePath)
	if err != nil {
		return nil, &GitCloneError{Code: GitCloneErrPathResolve, Message: "Failed to resolve clone path"}
	}
	if !strings.HasPrefix(absClonePath, absWorkDir+string(filepath.Separator)) {
		return nil, &GitCloneError{Code: GitCloneErrPathOutside, Message: "Clone path must be a subdirectory of the working directory"}
	}

	if _, err := os.Stat(absolutePath); err == nil {
		if !req.Force {
			return nil, &GitCloneError{
				Code:         GitCloneErrDirectoryExists,
				Message:      fmt.Sprintf("Path already exists: %s", relativePath),
				Path:         relativePath,
				AbsolutePath: absolutePath,
			}
		}
		if err := os.RemoveAll(absolutePath); err != nil {
			return nil, &GitCloneError{
				Code:    GitCloneErrDeleteFailed,
				Message: fmt.Sprintf("Failed to delete existing path: %v", err),
			}
		}
	}

	cloneURL := req.URL
	if parsed, err := url.Parse(req.URL); err == nil {
		if token := tokens.TokenForHost(parsed.Hostname()); token != "" {
			cloneURL = InjectGitToken(req.URL, token)
		}
	}

	return &GitClonePlan{
		CloneURL:     cloneURL,
		RepoURL:      req.URL,
		AbsolutePath: absolutePath,
		RelativePath: relativePath,
		Ref:          req.Ref,
		RepoPath:     req.RepoPath,
		UsePTY:       req.UsePTY == nil || *req.UsePTY,
	}, nil
}

// StreamGitClone performs the clone using the plan and emits progress
// through sink. Transport-agnostic: the Gin handler passes a
// GinSSEGitSink, the IPC GitService passes an EmitterGitSink. This
// function closes the sink (via Status + Done) before returning; the
// caller does not need to emit anything.
func StreamGitClone(ctx context.Context, plan *GitClonePlan, sink GitEventSink) {
	sink.Log(fmt.Sprintf("Cloning into '%s'...", plan.RelativePath), false)

	var cloneErr error
	if plan.RepoPath != "" {
		cloneErr = performSparseClone(ctx, sink, plan.CloneURL, plan.AbsolutePath, plan.RepoPath, plan.Ref, plan.UsePTY)
	} else {
		cloneErr = performStandardClone(ctx, sink, plan.CloneURL, plan.AbsolutePath, plan.Ref, plan.UsePTY)
	}

	if cloneErr != nil {
		sanitizedErr := SanitizeGitError(cloneErr.Error())
		FailGit(sink, fmt.Sprintf("Clone failed: %s", sanitizedErr))
		return
	}

	fileCount := CountFiles(plan.AbsolutePath)

	sink.Log(fmt.Sprintf("Clone complete. %d files downloaded to %s", fileCount, plan.RelativePath), false)
	sink.Event("clone_result", GitCloneResultEvent{
		FileCount:    fileCount,
		AbsolutePath: plan.AbsolutePath,
		RelativePath: plan.RelativePath,
	})

	outputs := map[string]string{
		"clone_path": plan.AbsolutePath,
		"file_count": fmt.Sprintf("%d", fileCount),
		"repo_url":   plan.RepoURL,
	}
	if plan.Ref != "" {
		outputs["ref"] = plan.Ref
	}
	if owner, repo := parseOwnerRepoFromURL(plan.RepoURL); owner != "" {
		outputs["repo_owner"] = owner
		outputs["repo_name"] = repo
	}
	sink.Outputs(outputs)
	sink.Status("success", 0)
	sink.Done()
}

// =============================================================================
// Git Clone Handler
// =============================================================================

// HandleGitClone performs a git clone operation with real-time SSE
// streaming. POST /api/git/clone. Requires SessionAuthMiddleware. Thin
// shell over PrepareGitClone + StreamGitClone (see above).
func HandleGitClone(sm *SessionManager, workingDir string, tokens *TokenResolver) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitCloneRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}

		sessionPresent := GetSessionExecContext(c) != nil
		plan, cerr := PrepareGitClone(req, workingDir, tokens, sessionPresent)
		if cerr != nil {
			c.JSON(httpStatusForCloneError(cerr), gitCloneErrorToHTTPBody(cerr))
			return
		}

		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")

		flusher, ok := c.Writer.(http.Flusher)
		if !ok {
			sendSSEError(c, "Streaming not supported")
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()

		StreamGitClone(ctx, plan, NewGinSSEGitSink(c, flusher))
	}
}

// httpStatusForCloneError maps a GitCloneError's Code onto the HTTP
// status the legacy endpoint returned, keeping frontend error handling
// unchanged while HTTP remains in place.
func httpStatusForCloneError(e *GitCloneError) int {
	switch e.Code {
	case GitCloneErrNoSession:
		return http.StatusUnauthorized
	case GitCloneErrDirectoryExists:
		return http.StatusConflict
	case GitCloneErrPathResolve:
		return http.StatusInternalServerError
	case GitCloneErrDeleteFailed:
		return http.StatusInternalServerError
	default:
		return http.StatusBadRequest
	}
}

// gitCloneErrorToHTTPBody renders a GitCloneError as the legacy HTTP
// JSON body. The directory_exists variant carries extra fields the
// frontend uses to show a confirm-overwrite dialog.
func gitCloneErrorToHTTPBody(e *GitCloneError) gin.H {
	body := gin.H{"error": e.Code}
	if e.Code == GitCloneErrDirectoryExists {
		body["message"] = e.Message
		body["path"] = e.Path
		body["absolutePath"] = e.AbsolutePath
		return body
	}
	// Other errors historically used {"error": "<message>"} rather than
	// {"error": "<code>"}. Preserve that to avoid changing error text
	// frontend might display verbatim.
	body["error"] = e.Message
	return body
}

// =============================================================================
// Clone Operations
// =============================================================================

// buildCloneArgs returns the git args for a standard clone.
func buildCloneArgs(cloneURL, destPath, ref string) []string {
	args := []string{"clone", "--progress"}
	if ref != "" {
		args = append(args, "--branch", ref)
	}
	return append(args, cloneURL, destPath)
}

// sparseCloneStep represents one step of a sparse checkout operation.
type sparseCloneStep struct {
	args    []string
	errWrap string // e.g. "sparse clone failed"
}

// buildSparseCloneSteps returns the ordered git arg sets for a sparse checkout.
func buildSparseCloneSteps(cloneURL, destPath, repoPath, ref string) []sparseCloneStep {
	cloneArgs := []string{"clone", "--filter=blob:none", "--no-checkout", "--progress"}
	if ref != "" {
		cloneArgs = append(cloneArgs, "--branch", ref)
	}
	cloneArgs = append(cloneArgs, cloneURL, destPath)

	return []sparseCloneStep{
		{args: cloneArgs, errWrap: "sparse clone failed"},
		{args: []string{"-C", destPath, "sparse-checkout", "set", repoPath}, errWrap: "sparse-checkout set failed"},
		{args: []string{"-C", destPath, "checkout"}, errWrap: "checkout failed"},
	}
}

// GitCloneSimple performs a standard git clone without SSE streaming.
// It returns combined stdout/stderr output and any error.
// Exported for use by the testing package.
func GitCloneSimple(ctx context.Context, cloneURL, destPath, ref string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", buildCloneArgs(cloneURL, destPath, ref)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return output, fmt.Errorf("%w: %s", err, string(output))
	}
	return output, nil
}

// GitSparseCloneSimple performs a sparse checkout clone without SSE streaming.
// It clones only the specified repoPath subdirectory.
// Exported for use by the testing package.
func GitSparseCloneSimple(ctx context.Context, cloneURL, destPath, repoPath, ref string) ([]byte, error) {
	for _, step := range buildSparseCloneSteps(cloneURL, destPath, repoPath, ref) {
		cmd := exec.CommandContext(ctx, "git", step.args...)
		if output, err := cmd.CombinedOutput(); err != nil {
			return output, fmt.Errorf("%s: %w: %s", step.errWrap, err, string(output))
		}
	}
	return nil, nil
}

// performStandardClone does a regular git clone and streams output through sink.
func performStandardClone(ctx context.Context, sink GitEventSink, cloneURL, destPath, ref string, usePTY bool) error {
	return streamGitCommand(ctx, sink, buildCloneArgs(cloneURL, destPath, ref), "", usePTY)
}

// performSparseClone does a sparse checkout to clone only a specific subdirectory, streaming output through sink.
func performSparseClone(ctx context.Context, sink GitEventSink, cloneURL, destPath, repoPath, ref string, usePTY bool) error {
	stepMessages := []string{
		"Setting up sparse checkout...",
		fmt.Sprintf("Configuring sparse checkout for path: %s", repoPath),
		"Checking out files...",
	}

	for i, step := range buildSparseCloneSteps(cloneURL, destPath, repoPath, ref) {
		sink.Log(stepMessages[i], false)
		if err := streamGitCommand(ctx, sink, step.args, "", usePTY); err != nil {
			return fmt.Errorf("%s: %w", step.errWrap, err)
		}
	}

	return nil
}

// streamGitCommand runs a git command and streams output through sink.
// When usePTY is true and PTY is supported, it uses PTY for better terminal emulation
// (progress bars, colors, etc.) and falls back to pipes if PTY fails.
func streamGitCommand(ctx context.Context, sink GitEventSink, gitArgs []string, workDir string, usePTY bool) error {
	outputChan := make(chan outputLine, 100)
	doneChan := make(chan error, 1)

	cmd := exec.CommandContext(ctx, "git", gitArgs...)
	if workDir != "" {
		cmd.Dir = workDir
	}

	var started bool
	var wg sync.WaitGroup

	// Try PTY first if requested and supported
	if usePTY && ptySupported() {
		ptmx, err := startCommandWithPTY(cmd)
		if err == nil {
			started = true
			wg.Add(1)
			go func() {
				defer wg.Done()
				streamPTYOutput(ptmx, outputChan)
			}()
			go func() {
				doneChan <- cmd.Wait()
			}()
		} else {
			// PTY failed, recreate command for pipe fallback
			cmd = exec.CommandContext(ctx, "git", gitArgs...)
			if workDir != "" {
				cmd.Dir = workDir
			}
		}
	}

	// Fallback to pipe-based execution
	if !started {
		stderr, err := cmd.StderrPipe()
		if err != nil {
			return fmt.Errorf("failed to create stderr pipe: %w", err)
		}

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return fmt.Errorf("failed to create stdout pipe: %w", err)
		}

		if err := cmd.Start(); err != nil {
			return fmt.Errorf("failed to start git: %w", err)
		}

		wg.Add(2)
		go func() {
			defer wg.Done()
			streamOutput(stderr, outputChan)
		}()
		go func() {
			defer wg.Done()
			streamOutput(stdout, outputChan)
		}()

		go func() {
			doneChan <- cmd.Wait()
		}()
	}

	// Stream output via the sink until done
	for {
		select {
		case out := <-outputChan:
			sink.Log(SanitizeGitError(out.Line), out.Replace)
		case err := <-doneChan:
			// Wait for all reader goroutines to finish, then close
			// outputChan so the drain loop below sees every line.
			wg.Wait()
			close(outputChan)

			// Drain any remaining output
			for out := range outputChan {
				sink.Log(SanitizeGitError(out.Line), out.Replace)
			}
			if err != nil {
				exitCode := 1
				if exitErr, ok := err.(*exec.ExitError); ok {
					exitCode = exitErr.ExitCode()
				}
				return fmt.Errorf("git command exited with code %d", exitCode)
			}
			return nil
		case <-ctx.Done():
			if cmd.Process != nil {
				cmd.Process.Kill()
			}
			return fmt.Errorf("operation timed out")
		}
	}
}

// =============================================================================
// GitHub API Helpers
// =============================================================================

// doGitHubAPIGet creates and executes an authenticated GitHub API GET request.
// It sets the standard Authorization, Accept, and API version headers.
// The caller is responsible for closing resp.Body on success.
// Returns an error if the request fails or the status code is not 200.
func doGitHubAPIGet(ctx context.Context, token, apiURL string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call GitHub API: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	return resp, nil
}

// doGitHubAPIPost creates and executes an authenticated GitHub API POST request.
// It sets the standard Authorization, Accept, API version, and Content-Type headers.
// The caller is responsible for closing resp.Body on success.
// Unlike doGitHubAPIGet, this does NOT check the status code — callers handle
// different expected status codes (e.g. 200 for labels, 201 for PR creation).
func doGitHubAPIPost(ctx context.Context, token, apiURL string, jsonBody []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", apiURL, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call GitHub API: %w", err)
	}

	return resp, nil
}

// fetchGitHubOrgs fetches the organizations for the authenticated user.
func fetchGitHubOrgs(ctx context.Context, token string) ([]GitHubOrg, error) {
	resp, err := doGitHubAPIGet(ctx, token, GitHubAPIBaseURL+"/user/orgs?per_page=100")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var rawOrgs []struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&rawOrgs); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	orgs := make([]GitHubOrg, len(rawOrgs))
	for i, o := range rawOrgs {
		orgs[i] = GitHubOrg{
			Login:     o.Login,
			AvatarURL: o.AvatarURL,
			Type:      "Organization",
		}
	}

	return orgs, nil
}

// ghRepoRaw is the JSON shape returned by GitHub's repo list and search APIs.
type ghRepoRaw struct {
	Name        string `json:"name"`
	FullName    string `json:"full_name"`
	Private     bool   `json:"private"`
	Description string `json:"description"`
}

// fetchGitHubRepos fetches repositories for a given owner. If query is provided, uses the search API.
func fetchGitHubRepos(ctx context.Context, token, owner, query string) ([]GitHubRepo, error) {
	var apiURL string
	if query != "" {
		// Use search API for filtering
		q := fmt.Sprintf("%s user:%s fork:true", query, owner)
		apiURL = fmt.Sprintf("%s/search/repositories?q=%s&per_page=30&sort=updated", GitHubAPIBaseURL, url.QueryEscape(q))
	} else {
		// List repos for user/org
		apiURL = fmt.Sprintf("%s/users/%s/repos?per_page=100&sort=updated&type=all", GitHubAPIBaseURL, url.PathEscape(owner))
	}

	resp, err := doGitHubAPIGet(ctx, token, apiURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Parse response - different format for search vs list
	var rawRepos []ghRepoRaw
	if query != "" {
		// Search API wraps results in { items: [...] }
		var searchResult struct {
			Items []ghRepoRaw `json:"items"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&searchResult); err != nil {
			return nil, fmt.Errorf("failed to parse search response: %w", err)
		}
		rawRepos = searchResult.Items
	} else {
		if err := json.NewDecoder(resp.Body).Decode(&rawRepos); err != nil {
			return nil, fmt.Errorf("failed to parse response: %w", err)
		}
	}

	repos := make([]GitHubRepo, len(rawRepos))
	for i, r := range rawRepos {
		repos[i] = GitHubRepo{
			Name:        r.Name,
			FullName:    r.FullName,
			Private:     r.Private,
			Description: r.Description,
		}
	}

	return repos, nil
}

// gitHubBranchInfo is an internal type used by fetchGitHubBranches.
type gitHubBranchInfo struct {
	Name      string
	IsDefault bool
}

// fetchGitHubBranches fetches branches for a given owner/repo.
// If query is provided, filters branches by name (case-insensitive contains).
// Returns up to 300 branches (3 pages), the total count, and any error.
func fetchGitHubBranches(ctx context.Context, token, owner, repo, query string) ([]gitHubBranchInfo, int, error) {
	// First, get the default branch name from the repo metadata
	repoURL := fmt.Sprintf("%s/repos/%s/%s", GitHubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo))
	repoResp, err := doGitHubAPIGet(ctx, token, repoURL)
	if err != nil {
		return nil, 0, err
	}
	defer repoResp.Body.Close()

	var repoInfo struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := json.NewDecoder(repoResp.Body).Decode(&repoInfo); err != nil {
		return nil, 0, fmt.Errorf("failed to parse repo info: %w", err)
	}

	// Fetch branches with pagination (up to 3 pages of 100)
	var allBranches []gitHubBranchInfo
	totalCount := 0
	maxPages := 3

	for page := 1; page <= maxPages; page++ {
		apiURL := fmt.Sprintf("%s/repos/%s/%s/branches?per_page=100&page=%d",
			GitHubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo), page)

		resp, err := doGitHubAPIGet(ctx, token, apiURL)
		if err != nil {
			return nil, 0, err
		}

		var pageBranches []struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&pageBranches); err != nil {
			resp.Body.Close()
			return nil, 0, fmt.Errorf("failed to parse response: %w", err)
		}
		resp.Body.Close()

		for _, b := range pageBranches {
			allBranches = append(allBranches, gitHubBranchInfo{
				Name:      b.Name,
				IsDefault: b.Name == repoInfo.DefaultBranch,
			})
		}

		totalCount += len(pageBranches)

		// If we got fewer than per_page results, there are no more pages
		if len(pageBranches) < 100 {
			break
		}
	}

	// Filter by query if provided (case-insensitive contains)
	if query != "" {
		lowerQuery := strings.ToLower(query)
		var filtered []gitHubBranchInfo
		for _, b := range allBranches {
			if strings.Contains(strings.ToLower(b.Name), lowerQuery) {
				filtered = append(filtered, b)
			}
		}
		allBranches = filtered
	}

	// Sort: default branch first, then alphabetical
	sort.Slice(allBranches, func(i, j int) bool {
		if allBranches[i].IsDefault != allBranches[j].IsDefault {
			return allBranches[i].IsDefault
		}
		return allBranches[i].Name < allBranches[j].Name
	})

	return allBranches, totalCount, nil
}

// fetchGitHubTags fetches tags for a given owner/repo.
// If query is provided, filters tags by name (case-insensitive contains).
// Returns up to 300 tags (3 pages), the total count, and any error.
func fetchGitHubTags(ctx context.Context, token, owner, repo, query string) ([]GitHubRef, int, error) {
	var allTags []GitHubRef
	totalCount := 0
	maxPages := 3

	for page := 1; page <= maxPages; page++ {
		apiURL := fmt.Sprintf("%s/repos/%s/%s/tags?per_page=100&page=%d",
			GitHubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo), page)

		resp, err := doGitHubAPIGet(ctx, token, apiURL)
		if err != nil {
			return nil, 0, err
		}

		var pageTags []struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&pageTags); err != nil {
			resp.Body.Close()
			return nil, 0, fmt.Errorf("failed to parse tags response: %w", err)
		}
		resp.Body.Close()

		for _, t := range pageTags {
			allTags = append(allTags, GitHubRef{
				Name:            t.Name,
				Type:            "tag",
				IsDefaultBranch: false,
			})
		}

		totalCount += len(pageTags)

		if len(pageTags) < 100 {
			break
		}
	}

	// Filter by query if provided (case-insensitive contains)
	if query != "" {
		lowerQuery := strings.ToLower(query)
		var filtered []GitHubRef
		for _, t := range allTags {
			if strings.Contains(strings.ToLower(t.Name), lowerQuery) {
				filtered = append(filtered, t)
			}
		}
		allTags = filtered
	}

	return allTags, totalCount, nil
}

// =============================================================================
// Helper Functions
// =============================================================================

// getGitHubTokenFromSession retrieves a GitHub token from the session environment.
// Checks GITHUB_TOKEN first, then GH_TOKEN.
func getGitHubTokenFromSession(sm *SessionManager) string {
	session, ok := sm.GetSession()
	if !ok || session == nil {
		return ""
	}

	if token, ok := session.Env["GITHUB_TOKEN"]; ok && token != "" {
		return token
	}
	if token, ok := session.Env["GH_TOKEN"]; ok && token != "" {
		return token
	}
	return ""
}

// IsGitHubURL checks if a URL points to github.com
func IsGitHubURL(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	hostname := strings.ToLower(parsed.Hostname())
	return hostname == "github.com" || strings.HasSuffix(hostname, ".github.com")
}

// InjectGitToken injects a token into an HTTPS git URL for authentication.
// The token name varies by host: GitHub uses "x-access-token", GitLab uses "oauth2".
// Returns the URL unchanged if token is empty or the URL is not HTTPS.
func InjectGitToken(rawURL, token string) string {
	if token == "" {
		return rawURL
	}

	if !strings.HasPrefix(strings.ToLower(rawURL), "https://") {
		return rawURL
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	parsed.User = url.UserPassword(tokenUsernameForHost(parsed.Hostname()), token)
	return parsed.String()
}

// tokenUsernameForHost returns the HTTP basic-auth username for injecting
// a token into a git clone URL. GitLab uses "oauth2"; everything else
// (GitHub, etc.) uses "x-access-token".
func tokenUsernameForHost(host string) string {
	if strings.ToLower(host) == "gitlab.com" {
		return "oauth2"
	}
	return "x-access-token"
}

// ResolveClonePaths computes absolute and relative paths for a clone destination.
// localPath is the user-specified destination (may be empty). cloneURL is used as
// a fallback to derive the repo name. workDir is the base directory.
func ResolveClonePaths(localPath, cloneURL, workDir string) (absolutePath, relativePath string) {
	dest := localPath
	if dest == "" {
		dest = RepoNameFromURL(cloneURL)
	}

	if filepath.IsAbs(dest) {
		absolutePath = dest
	} else {
		absolutePath = filepath.Join(workDir, dest)
	}

	rel, err := filepath.Rel(workDir, absolutePath)
	if err != nil {
		rel = dest
	}
	if !strings.HasPrefix(rel, ".") {
		rel = "./" + rel
	}
	relativePath = rel
	return
}

// RepoNameFromURL extracts the repository name from a git URL.
// e.g., "https://github.com/org/repo.git" -> "repo"
func RepoNameFromURL(rawURL string) string {
	if _, repo := parseOwnerRepoFromURL(rawURL); repo != "" {
		return repo
	}
	return "repo"
}

// isValidGitURL performs basic validation on a git URL.
func isValidGitURL(rawURL string) bool {
	if rawURL == "" {
		return false
	}

	// HTTPS URLs
	if strings.HasPrefix(rawURL, "https://") || strings.HasPrefix(rawURL, "http://") {
		_, err := url.Parse(rawURL)
		return err == nil
	}

	// SSH URLs: git@host:org/repo.git
	if sshURLPattern.MatchString(rawURL) {
		return true
	}

	// git:// protocol
	if strings.HasPrefix(rawURL, "git://") {
		return true
	}

	// file:// protocol (local repos)
	if strings.HasPrefix(rawURL, "file://") {
		return true
	}

	return false
}

// isValidGitHubOwner validates a GitHub owner name (org or user).
func isValidGitHubOwner(owner string) bool {
	if owner == "" || len(owner) > 39 {
		return false
	}
	return gitHubOwnerPattern.MatchString(owner)
}

// isValidGitHubRepoName validates a GitHub repository name.
// GitHub repo names can contain alphanumeric characters, hyphens, underscores, and dots.
func isValidGitHubRepoName(name string) bool {
	if name == "" || len(name) > 100 {
		return false
	}
	return gitHubRepoNamePattern.MatchString(name)
}

// CountFiles counts the number of files in a directory, excluding .git.
func CountFiles(dir string) int {
	count := 0
	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		// Skip .git directory
		if info.IsDir() && info.Name() == ".git" {
			return filepath.SkipDir
		}
		if !info.IsDir() {
			count++
		}
		return nil
	})
	return count
}

// SanitizeGitError removes tokens from git error messages.
func SanitizeGitError(msg string) string {
	return tokenSanitizePattern.ReplaceAllString(msg, "")
}
