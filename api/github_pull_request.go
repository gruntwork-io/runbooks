package api

import (
	"context"
	"encoding/json"
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

// HandleGitHubListLabels returns labels for a given repository.
// GET /api/github/labels?owner={owner}&repo={repo}
// Requires SessionAuthMiddleware.
func HandleGitHubListLabels(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		owner := c.Query("owner")
		repo := c.Query("repo")
		if owner == "" || repo == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "owner and repo query parameters are required"})
			return
		}

		if !isValidGitHubOwner(owner) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid owner name"})
			return
		}

		if !isValidGitHubRepoName(repo) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid repository name"})
			return
		}

		token := getGitHubTokenFromSession(sm)
		if token == "" {
			c.JSON(http.StatusOK, gin.H{"labels": []interface{}{}, "error": "No GitHub token found in session"})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()

		apiURL := fmt.Sprintf("%s/repos/%s/%s/labels?per_page=100",
			GitHubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo))

		resp, err := doGitHubAPIGet(ctx, token, apiURL)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"labels": []interface{}{}, "error": fmt.Sprintf("Failed to fetch labels: %v", err)})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			c.JSON(http.StatusOK, gin.H{
				"labels": []interface{}{},
				"error":  fmt.Sprintf("GitHub API returned status %d: %s", resp.StatusCode, string(body)),
			})
			return
		}

		var rawLabels []struct {
			Name        string `json:"name"`
			Color       string `json:"color"`
			Description string `json:"description"`
		}

		if err := json.NewDecoder(resp.Body).Decode(&rawLabels); err != nil {
			c.JSON(http.StatusOK, gin.H{"labels": []interface{}{}, "error": "Failed to parse labels response"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"labels": rawLabels})
	}
}

// HandleGitPullRequest creates a pull request with real-time SSE streaming.
// POST /api/git/pull-request
// Requires SessionAuthMiddleware.
func HandleGitPullRequest(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req CreatePullRequestRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}

		if req.Title == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "title is required"})
			return
		}
		if req.BranchName == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "branchName is required"})
			return
		}
		if req.LocalPath == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "localPath is required"})
			return
		}
		if err := ValidateAbsolutePathInCwd(req.LocalPath); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid localPath: %v", err)})
			return
		}
		if req.RepoURL == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "repoUrl is required"})
			return
		}

		token := getGitHubTokenFromSession(sm)
		if token == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "No GitHub token found in session"})
			return
		}

		commitMessage := req.CommitMessage
		if commitMessage == "" {
			commitMessage = "Changes from runbook"
		}

		// Parse owner/repo from URL
		owner, repo := parseOwnerRepoFromURL(req.RepoURL)
		if owner == "" || repo == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Could not parse owner/repo from repository URL"})
			return
		}

		// Set up SSE headers
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")

		flusher, ok := c.Writer.(http.Flusher)
		if !ok {
			sendSSEError(c, "Streaming not supported")
			return
		}
		sse := &sseWriter{c: c, flusher: flusher}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()

		// Step 1: Create branch
		sse.log(fmt.Sprintf("Creating branch %s...", req.BranchName))
		if err := runGitCommandCtx(ctx, req.LocalPath, "checkout", "-b", req.BranchName); err != nil {
			sse.fail(fmt.Sprintf("Failed to create branch: %s", SanitizeGitError(err.Error())))
			return
		}

		// Step 2: Check for changes and commit
		sse.log("Checking for changes...")
		hasChanges, err := gitHasChanges(ctx, req.LocalPath)
		if err != nil {
			sse.fail(fmt.Sprintf("Failed to check for changes: %s", err.Error()))
			return
		}

		if hasChanges {
			sse.log("Staging changes...")
			if err := runGitCommandCtx(ctx, req.LocalPath, "add", "-A"); err != nil {
				sse.fail(fmt.Sprintf("Failed to stage changes: %s", SanitizeGitError(err.Error())))
				return
			}

			sse.log(fmt.Sprintf("Committing: %s", commitMessage))
			if err := runGitCommandCtx(ctx, req.LocalPath, "commit", "-m", commitMessage); err != nil {
				sse.fail(fmt.Sprintf("Failed to commit: %s", SanitizeGitError(err.Error())))
				return
			}
		} else {
			// Create an empty commit so the PR has at least one commit ahead of the base branch.
			// Without this, GitHub rejects the PR with "No commits between main and <branch>".
			sse.log("No file changes found, creating empty commit...")
			if err := runGitCommandCtx(ctx, req.LocalPath, "commit", "--allow-empty", "-m", commitMessage); err != nil {
				sse.fail(fmt.Sprintf("Failed to create empty commit: %s", SanitizeGitError(err.Error())))
				return
			}
		}

		// Step 3: Push branch
		sse.log(fmt.Sprintf("Pushing branch to origin/%s...", req.BranchName))
		if err := gitPushWithToken(ctx, req.LocalPath, req.BranchName, token, true); err != nil {
			sse.fail(fmt.Sprintf("Push failed: %s", SanitizeGitError(err.Error())))
			return
		}

		// Step 4: Determine base branch
		sse.log("Determining base branch...")
		baseBranch := getBaseBranch(ctx, req.LocalPath, token, owner, repo)
		sse.log(fmt.Sprintf("Base branch: %s", baseBranch))

		// Step 5: Create PR via GitHub API
		sse.log("Creating pull request...")
		prResult, err := createGitHubPR(ctx, token, owner, repo, req.Title, req.Description, req.BranchName, baseBranch)
		if err != nil {
			sse.fail(fmt.Sprintf("Failed to create pull request: %s", err.Error()))
			return
		}

		sse.log(fmt.Sprintf("Pull request #%d created: %s", prResult.PRNumber, prResult.PRUrl))

		// Step 6: Add labels if any
		if len(req.Labels) > 0 {
			sse.log(fmt.Sprintf("Adding labels: %s", strings.Join(req.Labels, ", ")))
			if err := addGitHubLabels(ctx, token, owner, repo, prResult.PRNumber, req.Labels); err != nil {
				sse.log(fmt.Sprintf("Warning: Failed to add labels: %s", err.Error()))
				// Don't fail the whole operation for label errors
			}
		}

		// Send PR result event
		sse.event("pr_result", prResult)

		// Send outputs
		outputs := map[string]string{
			"PR_ID":  fmt.Sprintf("%d", prResult.PRNumber),
			"PR_URL": prResult.PRUrl,
		}
		sse.outputs(outputs)
		sse.status("success", 0)
		sse.done()
	}
}

// HandleGitPush pushes additional changes to an existing branch with SSE streaming.
// POST /api/git/push
// Requires SessionAuthMiddleware.
func HandleGitPush(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitPushRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}

		if req.LocalPath == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "localPath is required"})
			return
		}
		if err := ValidateAbsolutePathInCwd(req.LocalPath); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid localPath: %v", err)})
			return
		}
		if req.BranchName == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "branchName is required"})
			return
		}

		token := getGitHubTokenFromSession(sm)
		if token == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "No GitHub token found in session"})
			return
		}

		// Set up SSE headers
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")

		flusher, ok := c.Writer.(http.Flusher)
		if !ok {
			sendSSEError(c, "Streaming not supported")
			return
		}
		sse := &sseWriter{c: c, flusher: flusher}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()

		// Check for changes
		sse.log("Checking for changes...")
		hasChanges, err := gitHasChanges(ctx, req.LocalPath)
		if err != nil {
			sse.fail(fmt.Sprintf("Failed to check for changes: %s", err.Error()))
			return
		}

		if !hasChanges {
			sse.log("No changes to push")
			sse.status("success", 0)
			sse.done()
			return
		}

		// Stage and commit
		sse.log("Staging changes...")
		if err := runGitCommandCtx(ctx, req.LocalPath, "add", "-A"); err != nil {
			sse.fail(fmt.Sprintf("Failed to stage changes: %s", SanitizeGitError(err.Error())))
			return
		}

		sse.log("Committing: Additional changes")
		if err := runGitCommandCtx(ctx, req.LocalPath, "commit", "-m", "Additional changes"); err != nil {
			sse.fail(fmt.Sprintf("Failed to commit: %s", SanitizeGitError(err.Error())))
			return
		}

		// Push
		sse.log(fmt.Sprintf("Pushing to origin/%s...", req.BranchName))
		if err := gitPushWithToken(ctx, req.LocalPath, req.BranchName, token, false); err != nil {
			sse.fail(fmt.Sprintf("Push failed: %s", SanitizeGitError(err.Error())))
			return
		}

		sse.log("Push complete")
		sse.status("success", 0)
		sse.done()
	}
}

// =============================================================================
// Git Helpers
// =============================================================================

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
	tokenURL := InjectGitHubToken(originalURL, token)
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
