package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Types
// =============================================================================

// CreatePullRequestRequest represents the request body for POST /api/git/pull-request
type CreatePullRequestRequest struct {
	Title         string   `json:"title"`
	Description   string   `json:"description"`
	Labels        []string `json:"labels,omitempty"`
	BranchName    string   `json:"branchName"`
	CommitMessage string   `json:"commitMessage,omitempty"`
	LocalPath     string   `json:"localPath"`
	RepoURL       string   `json:"repoUrl"`
}

// GitPushRequest represents the request body for POST /api/git/push
type GitPushRequest struct {
	LocalPath  string `json:"localPath"`
	BranchName string `json:"branchName"`
}

// GitDeleteBranchRequest represents the request body for DELETE /api/git/branch
type GitDeleteBranchRequest struct {
	LocalPath  string `json:"localPath"`
	BranchName string `json:"branchName"`
}

// PRResultEvent is sent as an SSE event on successful PR creation
type PRResultEvent struct {
	PRUrl      string `json:"prUrl"`
	PRNumber   int    `json:"prNumber"`
	BranchName string `json:"branchName"`
}

// gitHubPRResponse is the JSON response from GitHub's create PR API
type gitHubPRResponse struct {
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
}

// =============================================================================
// Handlers
// =============================================================================

// HandleGitHubListLabels returns labels for a given repository. Thin
// shell over ListGitHubLabels (see github_ops.go).
// GET /api/github/labels?owner={owner}&repo={repo}. Requires
// SessionAuthMiddleware.
func HandleGitHubListLabels(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		c.JSON(http.StatusOK, ListGitHubLabels(ctx, sm, GitHubListLabelsRequest{
			Owner: c.Query("owner"),
			Repo:  c.Query("repo"),
		}))
	}
}

// GitPullRequestError is the shaped pre-flight failure a PR request
// can surface before streaming starts. Code lets the HTTP path pick a
// status and the IPC path stay transport-free.
type GitPullRequestError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *GitPullRequestError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

// Pull-request pre-flight error codes.
const (
	GitPRErrInvalidRequest = "invalid_request"
	GitPRErrNoToken        = "no_github_token"
)

// validateGitBranchName rejects branch strings that could be interpreted
// as refspecs, git flags, or otherwise-dangerous refs before they reach
// `git checkout -b` / `git push origin <ref>` / `git branch -D`. Modeled
// after git-check-ref-format(1) with an extra ban on ":" so a caller
// can't smuggle a refspec like "feature:main" that would push to an
// unintended remote ref. Returns nil on valid names.
func validateGitBranchName(name string) error {
	if name == "" {
		return fmt.Errorf("branch name is required")
	}
	if strings.ContainsAny(name, "\x00 \t\n\r~^:?*[\\") {
		return fmt.Errorf("branch name contains invalid characters")
	}
	if strings.Contains(name, "..") || strings.Contains(name, "@{") || strings.Contains(name, "//") {
		return fmt.Errorf("branch name contains invalid sequence")
	}
	if strings.HasPrefix(name, "-") || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "/") {
		return fmt.Errorf("branch name has invalid prefix")
	}
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, ".lock") || strings.HasSuffix(name, "/") {
		return fmt.Errorf("branch name has invalid suffix")
	}
	return nil
}

// PullRequestPlan is the validated, ready-to-stream form of a
// CreatePullRequestRequest. It carries the request plus fields derived
// from it (commit message default, owner/repo parse, resolved token).
type PullRequestPlan struct {
	req           CreatePullRequestRequest
	token         string
	owner         string
	repo          string
	commitMessage string
}

// PreparePullRequest validates a PR request and extracts the owner/repo
// + GitHub token. Like PrepareGitClone, returning a typed error here
// lets the HTTP path map codes to statuses and the IPC path pass the
// error straight back.
func PreparePullRequest(req CreatePullRequestRequest, sm *SessionManager) (*PullRequestPlan, *GitPullRequestError) {
	if req.Title == "" {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: "title is required"}
	}
	if req.BranchName == "" {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: "branchName is required"}
	}
	if err := validateGitBranchName(req.BranchName); err != nil {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: fmt.Sprintf("Invalid branchName: %v", err)}
	}
	if req.LocalPath == "" {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: "localPath is required"}
	}
	if err := ValidateAbsolutePathInCwd(req.LocalPath); err != nil {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: fmt.Sprintf("Invalid localPath: %v", err)}
	}
	if req.RepoURL == "" {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: "repoUrl is required"}
	}

	token := getGitHubTokenFromSession(sm)
	if token == "" {
		return nil, &GitPullRequestError{Code: GitPRErrNoToken, Message: "No GitHub token found in session"}
	}

	owner, repo := parseOwnerRepoFromURL(req.RepoURL)
	if owner == "" || repo == "" {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: "Could not parse owner/repo from repository URL"}
	}

	commitMessage := req.CommitMessage
	if commitMessage == "" {
		commitMessage = "Changes from gruntbook"
	}

	return &PullRequestPlan{
		req:           req,
		token:         token,
		owner:         owner,
		repo:          repo,
		commitMessage: commitMessage,
	}, nil
}

// StreamPullRequest performs the prepared PR flow (init empty repo if
// needed → create branch → commit → push → create PR → add labels) and
// emits progress through sink. The sink is closed (via Status + Done)
// before return.
func StreamPullRequest(ctx context.Context, plan *PullRequestPlan, sink GitEventSink) {
	req := plan.req
	token, owner, repo, commitMessage := plan.token, plan.owner, plan.repo, plan.commitMessage

	// Step 0: Handle empty repository (no commits yet).
	// When a repo has no commits, there's no base branch to open a PR against.
	// We initialize the default branch with an empty commit so the PR has a valid base.
	hasCommits, err := gitHasCommits(ctx, req.LocalPath)
	if err != nil {
		FailGit(sink, fmt.Sprintf("Failed to inspect repository: %s", SanitizeGitError(err.Error())))
		return
	}
	if !hasCommits {
		baseBranch := getBaseBranch(ctx, req.LocalPath, token, owner, repo)
		sink.Log(fmt.Sprintf("Repository has no commits. Initializing default branch (%s)...", baseBranch), false)

		// Point HEAD at the target branch before the first commit. The local
		// unborn branch (from init.defaultBranch) may not match the remote's
		// default branch (e.g., "master" locally vs "main" on GitHub).
		if err := runGitCommandCtx(ctx, req.LocalPath, "symbolic-ref", "HEAD", "refs/heads/"+baseBranch); err != nil {
			FailGit(sink, fmt.Sprintf("Failed to set branch to %s: %s", baseBranch, SanitizeGitError(err.Error())))
			return
		}

		if err := runGitCommandCtx(ctx, req.LocalPath, "commit", "--allow-empty", "-m", "Initial commit"); err != nil {
			FailGit(sink, fmt.Sprintf("Failed to initialize repository: %s", SanitizeGitError(err.Error())))
			return
		}

		if err := gitPushWithToken(ctx, req.LocalPath, baseBranch, token, true); err != nil {
			FailGit(sink, fmt.Sprintf("Failed to push initial commit: %s", SanitizeGitError(err.Error())))
			return
		}

		sink.Log(fmt.Sprintf("Default branch %s initialized with empty commit", baseBranch), false)
	}

	// Step 1: Create branch
	sink.Log(fmt.Sprintf("Creating branch %s...", req.BranchName), false)
	if err := runGitCommandCtx(ctx, req.LocalPath, "checkout", "-b", req.BranchName); err != nil {
		errMsg := SanitizeGitError(err.Error())
		if strings.Contains(errMsg, "already exists") {
			msg := fmt.Sprintf("Branch %q already exists.", req.BranchName)
			sink.Log(msg, false)
			sink.Event("error", map[string]any{
				"message":    msg,
				"code":       "branch_exists",
				"branchName": req.BranchName,
			})
			sink.Status("fail", 1)
			sink.Done()
		} else {
			FailGit(sink, fmt.Sprintf("Failed to create branch: %s", errMsg))
		}
		return
	}

	// Step 2: Check for changes and commit
	sink.Log("Checking for changes...", false)
	hasChanges, err := gitHasChanges(ctx, req.LocalPath)
	if err != nil {
		FailGit(sink, fmt.Sprintf("Failed to check for changes: %s", err.Error()))
		return
	}

	if hasChanges {
		sink.Log("Staging changes...", false)
		if err := runGitCommandCtx(ctx, req.LocalPath, "add", "-A"); err != nil {
			FailGit(sink, fmt.Sprintf("Failed to stage changes: %s", SanitizeGitError(err.Error())))
			return
		}

		sink.Log(fmt.Sprintf("Committing: %s", commitMessage), false)
		if err := runGitCommandCtx(ctx, req.LocalPath, "commit", "-m", commitMessage); err != nil {
			FailGit(sink, fmt.Sprintf("Failed to commit: %s", SanitizeGitError(err.Error())))
			return
		}
	} else {
		// Create an empty commit so the PR has at least one commit ahead of the base branch.
		// Without this, GitHub rejects the PR with "No commits between main and <branch>".
		sink.Log("No file changes found, creating empty commit...", false)
		if err := runGitCommandCtx(ctx, req.LocalPath, "commit", "--allow-empty", "-m", commitMessage); err != nil {
			FailGit(sink, fmt.Sprintf("Failed to create empty commit: %s", SanitizeGitError(err.Error())))
			return
		}
	}

	// Step 3: Push branch
	sink.Log(fmt.Sprintf("Pushing branch to origin/%s...", req.BranchName), false)
	if err := gitPushWithToken(ctx, req.LocalPath, req.BranchName, token, true); err != nil {
		FailGit(sink, fmt.Sprintf("Push failed: %s", SanitizeGitError(err.Error())))
		return
	}

	// Step 4: Determine base branch
	sink.Log("Determining base branch...", false)
	baseBranch := getBaseBranch(ctx, req.LocalPath, token, owner, repo)
	sink.Log(fmt.Sprintf("Base branch: %s", baseBranch), false)

	// Step 5: Create PR via GitHub API
	sink.Log("Creating pull request...", false)
	prResult, err := createGitHubPR(ctx, token, owner, repo, req.Title, req.Description, req.BranchName, baseBranch)
	if err != nil {
		FailGit(sink, fmt.Sprintf("Failed to create pull request: %s", err.Error()))
		return
	}

	sink.Log(fmt.Sprintf("Pull request #%d created: %s", prResult.PRNumber, prResult.PRUrl), false)

	// Step 6: Add labels if any
	if len(req.Labels) > 0 {
		sink.Log(fmt.Sprintf("Adding labels: %s", strings.Join(req.Labels, ", ")), false)
		if err := addGitHubLabels(ctx, token, owner, repo, prResult.PRNumber, req.Labels); err != nil {
			sink.Log(fmt.Sprintf("Warning: Failed to add labels: %s", err.Error()), false)
			// Don't fail the whole operation for label errors
		}
	}

	sink.Event("pr_result", prResult)
	sink.Outputs(map[string]string{
		"PR_ID":  fmt.Sprintf("%d", prResult.PRNumber),
		"PR_URL": prResult.PRUrl,
	})
	sink.Status("success", 0)
	sink.Done()
}

// HandleGitPullRequest creates a pull request with real-time SSE
// streaming. POST /api/git/pull-request. Requires SessionAuthMiddleware.
// Thin shell over preparePullRequest + StreamPullRequest.
func HandleGitPullRequest(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req CreatePullRequestRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}

		plan, cerr := PreparePullRequest(req, sm)
		if cerr != nil {
			status := http.StatusBadRequest
			if cerr.Code == GitPRErrNoToken {
				status = http.StatusUnauthorized
			}
			c.JSON(status, gin.H{"error": cerr.Message})
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

		StreamPullRequest(ctx, plan, NewGinSSEGitSink(c, flusher))
	}
}

// GitPushPlan is the validated, ready-to-stream form of a GitPushRequest.
type GitPushPlan struct {
	req   GitPushRequest
	token string
}

// prepareGitPush validates a push request and resolves the session token.
// Returns a GitPullRequestError (same shape, same code space) so the
// HTTP path can map codes to statuses uniformly.
func PrepareGitPush(req GitPushRequest, sm *SessionManager) (*GitPushPlan, *GitPullRequestError) {
	if req.LocalPath == "" {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: "localPath is required"}
	}
	if err := ValidateAbsolutePathInCwd(req.LocalPath); err != nil {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: fmt.Sprintf("Invalid localPath: %v", err)}
	}
	if req.BranchName == "" {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: "branchName is required"}
	}
	if err := validateGitBranchName(req.BranchName); err != nil {
		return nil, &GitPullRequestError{Code: GitPRErrInvalidRequest, Message: fmt.Sprintf("Invalid branchName: %v", err)}
	}

	token := getGitHubTokenFromSession(sm)
	if token == "" {
		return nil, &GitPullRequestError{Code: GitPRErrNoToken, Message: "No GitHub token found in session"}
	}
	return &GitPushPlan{req: req, token: token}, nil
}

// StreamGitPush runs the prepared push flow (stage → commit → push) and
// emits progress through sink. Sink is closed (via Status + Done)
// before return.
func StreamGitPush(ctx context.Context, plan *GitPushPlan, sink GitEventSink) {
	req := plan.req
	token := plan.token

	sink.Log("Checking for changes...", false)
	hasChanges, err := gitHasChanges(ctx, req.LocalPath)
	if err != nil {
		FailGit(sink, fmt.Sprintf("Failed to check for changes: %s", err.Error()))
		return
	}

	if !hasChanges {
		sink.Log("No changes to push", false)
		sink.Status("success", 0)
		sink.Done()
		return
	}

	sink.Log("Staging changes...", false)
	if err := runGitCommandCtx(ctx, req.LocalPath, "add", "-A"); err != nil {
		FailGit(sink, fmt.Sprintf("Failed to stage changes: %s", SanitizeGitError(err.Error())))
		return
	}

	sink.Log("Committing: Additional changes", false)
	if err := runGitCommandCtx(ctx, req.LocalPath, "commit", "-m", "Additional changes"); err != nil {
		FailGit(sink, fmt.Sprintf("Failed to commit: %s", SanitizeGitError(err.Error())))
		return
	}

	sink.Log(fmt.Sprintf("Pushing to origin/%s...", req.BranchName), false)
	if err := gitPushWithToken(ctx, req.LocalPath, req.BranchName, token, false); err != nil {
		FailGit(sink, fmt.Sprintf("Push failed: %s", SanitizeGitError(err.Error())))
		return
	}

	sink.Log("Push complete", false)
	sink.Status("success", 0)
	sink.Done()
}

// HandleGitPush pushes additional changes to an existing branch with
// SSE streaming. POST /api/git/push. Requires SessionAuthMiddleware.
// Thin shell over prepareGitPush + StreamGitPush.
func HandleGitPush(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitPushRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}

		plan, cerr := PrepareGitPush(req, sm)
		if cerr != nil {
			status := http.StatusBadRequest
			if cerr.Code == GitPRErrNoToken {
				status = http.StatusUnauthorized
			}
			c.JSON(status, gin.H{"error": cerr.Message})
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

		StreamGitPush(ctx, plan, NewGinSSEGitSink(c, flusher))
	}
}

// protectedBranches is the set of branch names that cannot be deleted via the API.
var protectedBranches = map[string]bool{
	"main":    true,
	"master":  true,
	"develop": true,
	"dev":     true,
	"staging": true,
	"release": true,
	"prod":    true,
	"production": true,
}

// GitDeleteBranchResponse is the IPC response for DeleteGitBranch. The
// legacy HTTP endpoint returned {"deleted": <name>} on success and
// {"error": <message>} on failure with a status code; the response
// shape here flattens both into one JSON body (Error populated on
// failure so the frontend can display it).
type GitDeleteBranchResponse struct {
	Deleted string `json:"deleted,omitempty"`
	Code    string `json:"code,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Delete-branch error codes. Kept distinct so the HTTP wrapper can map
// validation failures (400) vs operational ones (500).
const (
	GitDeleteBranchErrInvalid  = "invalid_request"
	GitDeleteBranchErrInternal = "internal"
)

// DeleteGitBranch deletes a local git branch after validating the
// branch name and refusing protected branches / currently-checked-out
// branches. Transport-free: the HTTP handler and IPC service both
// call this and map the Code field to their respective error shapes.
func DeleteGitBranch(ctx context.Context, req GitDeleteBranchRequest) GitDeleteBranchResponse {
	if req.LocalPath == "" {
		return GitDeleteBranchResponse{Code: GitDeleteBranchErrInvalid, Error: "localPath is required"}
	}
	if err := ValidateAbsolutePathInCwd(req.LocalPath); err != nil {
		return GitDeleteBranchResponse{Code: GitDeleteBranchErrInvalid, Error: fmt.Sprintf("Invalid localPath: %v", err)}
	}
	if req.BranchName == "" {
		return GitDeleteBranchResponse{Code: GitDeleteBranchErrInvalid, Error: "branchName is required"}
	}
	if err := validateGitBranchName(req.BranchName); err != nil {
		return GitDeleteBranchResponse{Code: GitDeleteBranchErrInvalid, Error: fmt.Sprintf("Invalid branchName: %v", err)}
	}

	if protectedBranches[req.BranchName] {
		return GitDeleteBranchResponse{Code: GitDeleteBranchErrInvalid, Error: fmt.Sprintf("Refusing to delete protected branch %q", req.BranchName)}
	}

	currentBranch, err := getCurrentBranch(ctx, req.LocalPath)
	if err == nil && currentBranch == req.BranchName {
		return GitDeleteBranchResponse{Code: GitDeleteBranchErrInvalid, Error: fmt.Sprintf("Cannot delete branch %q because it is currently checked out", req.BranchName)}
	}

	if err := runGitCommandCtx(ctx, req.LocalPath, "branch", "-D", req.BranchName); err != nil {
		return GitDeleteBranchResponse{Code: GitDeleteBranchErrInternal, Error: fmt.Sprintf("Failed to delete branch: %s", SanitizeGitError(err.Error()))}
	}

	return GitDeleteBranchResponse{Deleted: req.BranchName}
}

// HandleGitDeleteBranch deletes a local git branch.
// DELETE /api/git/branch. Requires SessionAuthMiddleware. Thin shell
// over DeleteGitBranch (see above).
func HandleGitDeleteBranch() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitDeleteBranchRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()

		resp := DeleteGitBranch(ctx, req)
		if resp.Code == "" {
			c.JSON(http.StatusOK, gin.H{"deleted": resp.Deleted})
			return
		}
		status := http.StatusBadRequest
		if resp.Code == GitDeleteBranchErrInternal {
			status = http.StatusInternalServerError
		}
		c.JSON(status, gin.H{"error": resp.Error})
	}
}

// getCurrentBranch returns the name of the currently checked-out branch.
func getCurrentBranch(ctx context.Context, dir string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "rev-parse", "--abbrev-ref", "HEAD")
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

// =============================================================================
// Git Helpers
// =============================================================================

// gitHasCommits returns true if the repository at dir has at least one commit.
// It distinguishes an unborn HEAD (exit code 128 → false, nil) from operational
// failures like a missing git binary or bad directory (false, err).
func gitHasCommits(ctx context.Context, dir string) (bool, error) {
	cmd := exec.CommandContext(ctx, "git", "rev-parse", "--verify", "HEAD")
	cmd.Dir = dir
	if err := cmd.Run(); err != nil {
		// Exit 128 is git's "fatal" status — here it means HEAD doesn't resolve
		// because the repo has no commits yet (unborn branch). Any other error
		// (e.g., git not installed, bad directory) is a real operational failure.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 128 {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// runGitCommandCtx runs a git command in the specified directory with context and returns any error.
func runGitCommandCtx(ctx context.Context, dir string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// gitHasChanges checks if there are any uncommitted changes in the working directory.
func gitHasChanges(ctx context.Context, dir string) (bool, error) {
	cmd := exec.CommandContext(ctx, "git", "status", "--porcelain")
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("git status failed: %w", err)
	}
	return strings.TrimSpace(string(output)) != "", nil
}

// gitPushWithToken pushes the current branch, temporarily injecting the token into the remote URL.
// If setUpstream is true, uses -u flag to set the upstream tracking reference.
func gitPushWithToken(ctx context.Context, dir, branchName, token string, setUpstream bool) error {
	// Get the current remote URL
	cmd := exec.CommandContext(ctx, "git", "remote", "get-url", "origin")
	cmd.Dir = dir
	originalURLBytes, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to get remote URL: %w", err)
	}
	originalURL := strings.TrimSpace(string(originalURLBytes))

	// Inject token into the URL
	tokenURL := InjectGitToken(originalURL, token)
	if err := runGitCommandCtx(ctx, dir, "remote", "set-url", "origin", tokenURL); err != nil {
		return fmt.Errorf("failed to set remote URL: %w", err)
	}

	// Restore original URL on exit using a detached context so the restore
	// still runs even if the caller's ctx is cancelled.
	defer func() {
		restoreCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := runGitCommandCtx(restoreCtx, dir, "remote", "set-url", "origin", originalURL); err != nil {
			fmt.Fprintf(os.Stderr, "WARNING: failed to restore original remote URL: %v\n", err)
		}
	}()

	// Push
	pushArgs := []string{"push"}
	if setUpstream {
		pushArgs = append(pushArgs, "-u")
	}
	pushArgs = append(pushArgs, "origin", branchName)

	if err := runGitCommandCtx(ctx, dir, pushArgs...); err != nil {
		return err
	}

	return nil
}

// getBaseBranch determines the default branch of the repository.
func getBaseBranch(ctx context.Context, dir, token, owner, repo string) string {
	// Try symbolic-ref first
	cmd := exec.CommandContext(ctx, "git", "symbolic-ref", "refs/remotes/origin/HEAD")
	cmd.Dir = dir
	output, err := cmd.Output()
	if err == nil {
		ref := strings.TrimSpace(string(output))
		// Strip "refs/remotes/origin/" prefix
		if parts := strings.SplitN(ref, "refs/remotes/origin/", 2); len(parts) == 2 {
			return parts[1]
		}
	}

	// Fallback: GitHub API
	apiCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	apiURL := fmt.Sprintf("%s/repos/%s/%s", GitHubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo))
	resp, err := doGitHubAPIGet(apiCtx, token, apiURL)
	if err == nil {
		defer resp.Body.Close()
		var repoInfo struct {
			DefaultBranch string `json:"default_branch"`
		}
		if json.NewDecoder(resp.Body).Decode(&repoInfo) == nil && repoInfo.DefaultBranch != "" {
			return repoInfo.DefaultBranch
		}
	}

	// Final fallback
	return "main"
}

// parseOwnerRepoFromURL extracts the owner and repo name from a GitHub URL.
// Supports HTTPS URLs (https://github.com/org/repo.git) and
// SSH URLs (git@github.com:org/repo.git).
func parseOwnerRepoFromURL(rawURL string) (owner, repo string) {
	// Handle SSH-style URLs: git@github.com:org/repo.git
	if idx := strings.Index(rawURL, ":"); idx >= 0 && !strings.Contains(rawURL, "://") {
		path := rawURL[idx+1:]
		path = strings.TrimSuffix(path, ".git")
		parts := strings.SplitN(path, "/", 3)
		if len(parts) >= 2 {
			return parts[0], parts[1]
		}
		return "", ""
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", ""
	}

	// Remove leading/trailing slashes, and .git suffix
	path := strings.Trim(parsed.Path, "/")
	path = strings.TrimSuffix(path, ".git")

	parts := strings.SplitN(path, "/", 3)
	if len(parts) < 2 {
		return "", ""
	}

	return parts[0], parts[1]
}

// =============================================================================
// GitHub API Helpers
// =============================================================================

// createGitHubPR creates a pull request via the GitHub API.
func createGitHubPR(ctx context.Context, token, owner, repo, title, description, head, base string) (*PRResultEvent, error) {
	apiURL := fmt.Sprintf("%s/repos/%s/%s/pulls",
		GitHubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo))

	jsonBody, err := json.Marshal(map[string]string{
		"title": title,
		"body":  description,
		"head":  head,
		"base":  base,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	resp, err := doGitHubAPIPost(ctx, token, apiURL, jsonBody)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	var prResp gitHubPRResponse
	if err := json.Unmarshal(respBody, &prResp); err != nil {
		return nil, fmt.Errorf("failed to parse PR response: %w", err)
	}

	return &PRResultEvent{
		PRUrl:      prResp.HTMLURL,
		PRNumber:   prResp.Number,
		BranchName: head,
	}, nil
}

// addGitHubLabels adds labels to a GitHub issue/PR.
func addGitHubLabels(ctx context.Context, token, owner, repo string, prNumber int, labels []string) error {
	apiURL := fmt.Sprintf("%s/repos/%s/%s/issues/%d/labels",
		GitHubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo), prNumber)

	jsonBody, err := json.Marshal(map[string][]string{"labels": labels})
	if err != nil {
		return fmt.Errorf("failed to marshal labels: %w", err)
	}

	resp, err := doGitHubAPIPost(ctx, token, apiURL, jsonBody)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}
