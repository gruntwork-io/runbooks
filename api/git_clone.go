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
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Pre-compiled regex patterns
var (
	sshURLPattern          = regexp.MustCompile(`^[\w.-]+@[\w.-]+:[\w./-]+$`)
	gitHubOwnerPattern     = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$`)
	gitHubRepoNamePattern  = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	tokenSanitizePattern   = regexp.MustCompile(`x-access-token:[^@]+@`)
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

// GitHubBranch represents a branch in a GitHub repository
type GitHubBranch struct {
	Name      string `json:"name"`
	IsDefault bool   `json:"isDefault"`
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

// gitHubAPISetup holds the common validated context for GitHub API handler calls.
type gitHubAPISetup struct {
	token  string
	user   *GitHubUserInfo
	ctx    context.Context
	cancel context.CancelFunc
}

// prepareGitHubAPICall validates the session token and returns a ready-to-use
// context, token, and validated user info. Returns a non-empty error message
// if setup fails; the caller is responsible for formatting the JSON response.
func prepareGitHubAPICall(c *gin.Context, sm *SessionManager) (*gitHubAPISetup, string) {
	token := getGitHubTokenFromSession(sm)
	if token == "" {
		return nil, "No GitHub token found in session"
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)

	user, _, err := validateGitHubToken(ctx, token)
	if err != nil {
		cancel()
		return nil, fmt.Sprintf("Failed to validate token: %v", err)
	}

	return &gitHubAPISetup{
		token:  token,
		user:   user,
		ctx:    ctx,
		cancel: cancel,
	}, ""
}

// HandleGitHubListOrgs returns the authenticated user's organizations plus their personal account.
// GET /api/github/orgs
// Requires SessionAuthMiddleware.
func HandleGitHubListOrgs(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		setup, errMsg := prepareGitHubAPICall(c, sm)
		if errMsg != "" {
			c.JSON(http.StatusOK, gin.H{"orgs": []GitHubOrg{}, "error": errMsg})
			return
		}
		defer setup.cancel()

		orgs := []GitHubOrg{
			{
				Login:     setup.user.Login,
				AvatarURL: setup.user.AvatarURL,
				Type:      "User",
			},
		}

		// Fetch organizations
		ghOrgs, err := fetchGitHubOrgs(setup.ctx, setup.token)
		if err != nil {
			// Return the user account even if org fetch fails
			c.JSON(http.StatusOK, gin.H{"orgs": orgs, "warning": fmt.Sprintf("Failed to list organizations: %v", err)})
			return
		}

		orgs = append(orgs, ghOrgs...)
		c.JSON(http.StatusOK, gin.H{"orgs": orgs})
	}
}

// HandleGitHubListRepos returns repositories for a given owner (user or org).
// GET /api/github/repos?owner=<owner>&query=<optional search>
// Requires SessionAuthMiddleware.
func HandleGitHubListRepos(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		owner := c.Query("owner")
		if owner == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "owner query parameter is required"})
			return
		}

		if !isValidGitHubOwner(owner) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid owner name"})
			return
		}

		setup, errMsg := prepareGitHubAPICall(c, sm)
		if errMsg != "" {
			c.JSON(http.StatusOK, gin.H{"repos": []GitHubRepo{}, "error": errMsg})
			return
		}
		defer setup.cancel()

		query := c.Query("query")
		repos, err := fetchGitHubRepos(setup.ctx, setup.token, owner, query)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"repos": []GitHubRepo{}, "error": fmt.Sprintf("Failed to list repositories: %v", err)})
			return
		}

		c.JSON(http.StatusOK, gin.H{"repos": repos})
	}
}

// HandleGitHubListBranches returns branches for a given owner/repo.
// GET /api/github/branches?owner=<owner>&repo=<repo>&query=<optional search>
// Requires SessionAuthMiddleware.
func HandleGitHubListBranches(sm *SessionManager) gin.HandlerFunc {
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

		setup, errMsg := prepareGitHubAPICall(c, sm)
		if errMsg != "" {
			c.JSON(http.StatusOK, gin.H{"branches": []GitHubBranch{}, "error": errMsg})
			return
		}
		defer setup.cancel()

		query := c.Query("query")
		branches, totalCount, err := fetchGitHubBranches(setup.ctx, setup.token, owner, repo, query)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"branches": []GitHubBranch{}, "error": fmt.Sprintf("Failed to list branches: %v", err)})
			return
		}

		result := gin.H{"branches": branches, "totalCount": totalCount}
		if totalCount > len(branches) {
			result["hasMore"] = true
		}
		c.JSON(http.StatusOK, result)
	}
}

// =============================================================================
// SSE Auto-Flush Writer
// =============================================================================

// sseWriter wraps a gin.Context and http.Flusher to auto-flush after each SSE event,
// eliminating repetitive flusher.Flush() calls throughout the clone handler.
type sseWriter struct {
	c       *gin.Context
	flusher http.Flusher
}

func (w *sseWriter) log(line string)                      { sendSSELog(w.c, line); w.flusher.Flush() }
func (w *sseWriter) status(status string, exitCode int)   { sendSSEStatus(w.c, status, exitCode); w.flusher.Flush() }
func (w *sseWriter) done()                                { sendSSEDone(w.c); w.flusher.Flush() }
func (w *sseWriter) outputs(outputs map[string]string)    { sendSSEOutputs(w.c, outputs); w.flusher.Flush() }
func (w *sseWriter) event(name string, data interface{})  { w.c.SSEvent(name, data); w.flusher.Flush() }

// =============================================================================
// Git Clone Handler
// =============================================================================

// HandleGitClone performs a git clone operation with real-time SSE streaming.
// POST /api/git/clone
// Requires SessionAuthMiddleware.
func HandleGitClone(sm *SessionManager, workingDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitCloneRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}

		if req.URL == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "url is required"})
			return
		}

		// Validate the URL
		if !isValidGitURL(req.URL) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid git URL format"})
			return
		}

		// Get session context for working directory
		execCtx := GetSessionExecContext(c)
		if execCtx == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Session context not found"})
			return
		}

		// Determine the effective working directory
		effectiveWorkDir := execCtx.WorkDir
		if effectiveWorkDir == "" {
			effectiveWorkDir = workingDir
		}

		absolutePath, relativePath := ResolveClonePaths(req.LocalPath, req.URL, effectiveWorkDir)

		// Check if destination already exists
		if info, err := os.Stat(absolutePath); err == nil && info.IsDir() {
			if !req.Force {
				c.JSON(http.StatusConflict, gin.H{
					"error":       "directory_exists",
					"message":     fmt.Sprintf("Directory already exists: %s", relativePath),
					"path":        relativePath,
					"absolutePath": absolutePath,
				})
				return
			}
			// Force mode: remove existing directory
			if err := os.RemoveAll(absolutePath); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{
					"error":   "delete_failed",
					"message": fmt.Sprintf("Failed to delete existing directory: %v", err),
				})
				return
			}
		}

		// Determine if we should inject a GitHub token
		cloneURL := req.URL
		if IsGitHubURL(req.URL) {
			if token := getGitHubTokenFromSession(sm); token != "" {
				cloneURL = InjectGitHubToken(req.URL, token)
			}
		}

		// Set up SSE headers
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("Transfer-Encoding", "chunked")

		flusher, ok := c.Writer.(http.Flusher)
		if !ok {
			sendSSEError(c, "Streaming not supported")
			return
		}
		sse := &sseWriter{c: c, flusher: flusher}

		// Create context with 5 minute timeout
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()

		// Determine if PTY should be used (defaults to true if not specified)
		usePTY := req.UsePTY == nil || *req.UsePTY

		sse.log(fmt.Sprintf("Cloning into '%s'...", relativePath))

		var cloneErr error
		if req.RepoPath != "" {
			cloneErr = performSparseClone(ctx, c, flusher, cloneURL, absolutePath, req.RepoPath, req.Ref, usePTY)
		} else {
			cloneErr = performStandardClone(ctx, c, flusher, cloneURL, absolutePath, req.Ref, usePTY)
		}

		if cloneErr != nil {
			sanitizedErr := SanitizeGitError(cloneErr.Error())
			sse.log(fmt.Sprintf("Clone failed: %s", sanitizedErr))
			sse.status("fail", 1)
			sse.done()
			return
		}

		// Count files (excluding .git directory)
		fileCount := CountFiles(absolutePath)

		sse.log(fmt.Sprintf("Clone complete. %d files downloaded to %s", fileCount, relativePath))
		sse.event("clone_result", GitCloneResultEvent{
			FileCount:    fileCount,
			AbsolutePath: absolutePath,
			RelativePath: relativePath,
		})

		// Send outputs event so the block can register outputs in RunbookContext
		outputs := map[string]string{
			"CLONE_PATH": absolutePath,
			"FILE_COUNT": fmt.Sprintf("%d", fileCount),
		}
		if req.Ref != "" {
			outputs["REF"] = req.Ref
		}
		sse.outputs(outputs)
		sse.status("success", 0)
		sse.done()
	}
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

// performStandardClone does a regular git clone and streams output via SSE.
func performStandardClone(ctx context.Context, c *gin.Context, flusher http.Flusher, cloneURL, destPath, ref string, usePTY bool) error {
	return streamGitCommand(ctx, c, flusher, buildCloneArgs(cloneURL, destPath, ref), "", usePTY)
}

// performSparseClone does a sparse checkout to clone only a specific subdirectory, streaming output via SSE.
func performSparseClone(ctx context.Context, c *gin.Context, flusher http.Flusher, cloneURL, destPath, repoPath, ref string, usePTY bool) error {
	sse := &sseWriter{c: c, flusher: flusher}
	stepMessages := []string{
		"Setting up sparse checkout...",
		fmt.Sprintf("Configuring sparse checkout for path: %s", repoPath),
		"Checking out files...",
	}

	for i, step := range buildSparseCloneSteps(cloneURL, destPath, repoPath, ref) {
		sse.log(stepMessages[i])
		if err := streamGitCommand(ctx, c, flusher, step.args, "", usePTY); err != nil {
			return fmt.Errorf("%s: %w", step.errWrap, err)
		}
	}

	return nil
}

// streamGitCommand runs a git command and streams output via SSE.
// When usePTY is true and PTY is supported, it uses PTY for better terminal emulation
// (progress bars, colors, etc.) and falls back to pipes if PTY fails.
func streamGitCommand(ctx context.Context, c *gin.Context, flusher http.Flusher, gitArgs []string, workDir string, usePTY bool) error {
	outputChan := make(chan outputLine, 100)
	doneChan := make(chan error, 1)

	cmd := exec.CommandContext(ctx, "git", gitArgs...)
	if workDir != "" {
		cmd.Dir = workDir
	}

	var started bool

	// Try PTY first if requested and supported
	if usePTY && ptySupported() {
		ptmx, err := startCommandWithPTY(cmd)
		if err == nil {
			started = true
			go streamPTYOutput(ptmx, outputChan)
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

		go streamOutput(stderr, outputChan)
		go streamOutput(stdout, outputChan)

		go func() {
			doneChan <- cmd.Wait()
		}()
	}

	// Stream output via SSE until done
	for {
		select {
		case out := <-outputChan:
			line := SanitizeGitError(out.Line)
			sendSSELogWithReplace(c, line, out.Replace)
			flusher.Flush()
		case err := <-doneChan:
			// Drain any remaining output
			for len(outputChan) > 0 {
				out := <-outputChan
				line := SanitizeGitError(out.Line)
				sendSSELogWithReplace(c, line, out.Replace)
				flusher.Flush()
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

// fetchGitHubBranches fetches branches for a given owner/repo.
// If query is provided, filters branches by name (case-insensitive contains).
// Returns up to 300 branches (3 pages), the total count from the first page's Link header,
// and any error.
func fetchGitHubBranches(ctx context.Context, token, owner, repo, query string) ([]GitHubBranch, int, error) {
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
	var allBranches []GitHubBranch
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
			allBranches = append(allBranches, GitHubBranch{
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
		var filtered []GitHubBranch
		for _, b := range allBranches {
			if strings.Contains(strings.ToLower(b.Name), lowerQuery) {
				filtered = append(filtered, b)
			}
		}
		allBranches = filtered
	}

	// Sort: default branch first, then alphabetical
	sortBranches(allBranches)

	return allBranches, totalCount, nil
}

// sortBranches sorts branches with the default branch first, then alphabetically.
func sortBranches(branches []GitHubBranch) {
	sort.Slice(branches, func(i, j int) bool {
		if branches[i].IsDefault != branches[j].IsDefault {
			return branches[i].IsDefault
		}
		return branches[i].Name < branches[j].Name
	})
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
	lower := strings.ToLower(rawURL)
	return strings.Contains(lower, "github.com")
}

// InjectGitHubToken injects a token into a GitHub HTTPS URL for authentication.
// Converts https://github.com/org/repo.git to https://x-access-token:{token}@github.com/org/repo.git
func InjectGitHubToken(rawURL, token string) string {
	// Only inject into HTTPS URLs
	if !strings.HasPrefix(strings.ToLower(rawURL), "https://") {
		return rawURL
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	parsed.User = url.UserPassword("x-access-token", token)
	return parsed.String()
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
	// Try parsing as a URL
	parsed, err := url.Parse(rawURL)
	if err == nil && parsed.Path != "" {
		base := filepath.Base(parsed.Path)
		return strings.TrimSuffix(base, ".git")
	}

	// Handle SSH-style URLs: git@github.com:org/repo.git
	if idx := strings.LastIndex(rawURL, "/"); idx >= 0 {
		base := rawURL[idx+1:]
		return strings.TrimSuffix(base, ".git")
	}

	if idx := strings.LastIndex(rawURL, ":"); idx >= 0 {
		base := rawURL[idx+1:]
		if slashIdx := strings.LastIndex(base, "/"); slashIdx >= 0 {
			base = base[slashIdx+1:]
		}
		return strings.TrimSuffix(base, ".git")
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
