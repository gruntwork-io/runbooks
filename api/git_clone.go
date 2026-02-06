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
	"strings"
	"time"

	"github.com/gin-gonic/gin"
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

// GitCloneRequest represents the request body for POST /api/git/clone
type GitCloneRequest struct {
	URL       string `json:"url"`
	RepoPath  string `json:"repo_path,omitempty"`
	LocalPath string `json:"local_path,omitempty"`
	UsePTY    *bool  `json:"use_pty,omitempty"` // Whether to use PTY for execution (default: true)
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

// HandleGitHubListOrgs returns the authenticated user's organizations plus their personal account.
// GET /api/github/orgs
// Requires SessionAuthMiddleware.
func HandleGitHubListOrgs(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := getGitHubTokenFromSession(sm)
		if token == "" {
			c.JSON(http.StatusOK, gin.H{"orgs": []GitHubOrg{}, "error": "No GitHub token found in session"})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()

		// Get the authenticated user first (for their personal account)
		user, _, err := validateGitHubToken(ctx, token)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"orgs": []GitHubOrg{}, "error": fmt.Sprintf("Failed to validate token: %v", err)})
			return
		}

		orgs := []GitHubOrg{
			{
				Login:     user.Login,
				AvatarURL: user.AvatarURL,
				Type:      "User",
			},
		}

		// Fetch organizations
		ghOrgs, err := fetchGitHubOrgs(ctx, token)
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

		// Validate owner is safe (alphanumeric, hyphens, underscores)
		if !isValidGitHubOwner(owner) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid owner name"})
			return
		}

		token := getGitHubTokenFromSession(sm)
		if token == "" {
			c.JSON(http.StatusOK, gin.H{"repos": []GitHubRepo{}, "error": "No GitHub token found in session"})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()

		query := c.Query("query")
		repos, err := fetchGitHubRepos(ctx, token, owner, query)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"repos": []GitHubRepo{}, "error": fmt.Sprintf("Failed to list repositories: %v", err)})
			return
		}

		c.JSON(http.StatusOK, gin.H{"repos": repos})
	}
}

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

		// Determine local path (destination)
		localPath := req.LocalPath
		if localPath == "" {
			localPath = RepoNameFromURL(req.URL)
		}

		// Resolve to absolute path
		var absolutePath string
		if filepath.IsAbs(localPath) {
			absolutePath = localPath
		} else {
			absolutePath = filepath.Join(effectiveWorkDir, localPath)
		}

		// Compute relative path from working directory
		relativePath, err := filepath.Rel(effectiveWorkDir, absolutePath)
		if err != nil {
			relativePath = localPath
		}
		if !strings.HasPrefix(relativePath, ".") {
			relativePath = "./" + relativePath
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

		// Create context with 5 minute timeout
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
		defer cancel()

		// Determine if PTY should be used (defaults to true if not specified)
		usePTY := req.UsePTY == nil || *req.UsePTY

		sendSSELog(c, fmt.Sprintf("Cloning into '%s'...", relativePath))
		flusher.Flush()

		var cloneErr error

		if req.RepoPath != "" {
			// Sparse checkout: clone with filter, then set sparse-checkout path
			cloneErr = performSparseClone(ctx, c, flusher, cloneURL, absolutePath, req.RepoPath, usePTY)
		} else {
			// Standard clone
			cloneErr = performStandardClone(ctx, c, flusher, cloneURL, absolutePath, usePTY)
		}

		if cloneErr != nil {
			// Sanitize error message to remove any embedded tokens
			sanitizedErr := SanitizeGitError(cloneErr.Error())
			sendSSELog(c, fmt.Sprintf("Clone failed: %s", sanitizedErr))
			flusher.Flush()
			sendSSEStatus(c, "fail", 1)
			flusher.Flush()
			sendSSEDone(c)
			flusher.Flush()
			return
		}

		// Count files (excluding .git directory)
		fileCount := CountFiles(absolutePath)

		sendSSELog(c, fmt.Sprintf("Clone complete. %d files downloaded to %s", fileCount, relativePath))
		flusher.Flush()

		// Send clone result event
		result := GitCloneResultEvent{
			FileCount:    fileCount,
			AbsolutePath: absolutePath,
			RelativePath: relativePath,
		}
		c.SSEvent("clone_result", result)
		flusher.Flush()

		// Send outputs event so the block can register outputs in RunbookContext
		outputs := map[string]string{
			"CLONE_PATH": absolutePath,
			"FILE_COUNT": fmt.Sprintf("%d", fileCount),
		}
		sendSSEOutputs(c, outputs)
		flusher.Flush()

		sendSSEStatus(c, "success", 0)
		flusher.Flush()

		sendSSEDone(c)
		flusher.Flush()
	}
}

// =============================================================================
// Clone Operations
// =============================================================================

// performStandardClone does a regular git clone and streams output.
func performStandardClone(ctx context.Context, c *gin.Context, flusher http.Flusher, cloneURL, destPath string, usePTY bool) error {
	args := []string{"clone", "--progress", cloneURL, destPath}
	return streamGitCommand(ctx, c, flusher, args, "", usePTY)
}

// performSparseClone does a sparse checkout to clone only a specific subdirectory.
func performSparseClone(ctx context.Context, c *gin.Context, flusher http.Flusher, cloneURL, destPath, repoPath string, usePTY bool) error {
	// Step 1: Clone with blob filter and no checkout
	sendSSELog(c, "Setting up sparse checkout...")
	flusher.Flush()

	args := []string{"clone", "--filter=blob:none", "--no-checkout", "--progress", cloneURL, destPath}
	if err := streamGitCommand(ctx, c, flusher, args, "", usePTY); err != nil {
		return fmt.Errorf("sparse clone failed: %w", err)
	}

	// Step 2: Set sparse-checkout to the requested path
	sendSSELog(c, fmt.Sprintf("Configuring sparse checkout for path: %s", repoPath))
	flusher.Flush()

	sparseArgs := []string{"-C", destPath, "sparse-checkout", "set", repoPath}
	if err := streamGitCommand(ctx, c, flusher, sparseArgs, "", usePTY); err != nil {
		return fmt.Errorf("sparse-checkout set failed: %w", err)
	}

	// Step 3: Checkout
	sendSSELog(c, "Checking out files...")
	flusher.Flush()

	checkoutArgs := []string{"-C", destPath, "checkout"}
	if err := streamGitCommand(ctx, c, flusher, checkoutArgs, "", usePTY); err != nil {
		return fmt.Errorf("checkout failed: %w", err)
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
			line := sanitizeGitOutput(out.Line)
			sendSSELogWithReplace(c, line, out.Replace)
			flusher.Flush()
		case err := <-doneChan:
			// Drain any remaining output
			for len(outputChan) > 0 {
				out := <-outputChan
				line := sanitizeGitOutput(out.Line)
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

// fetchGitHubOrgs fetches the organizations for the authenticated user.
func fetchGitHubOrgs(ctx context.Context, token string) ([]GitHubOrg, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", GitHubAPIBaseURL+"/user/orgs?per_page=100", nil)
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
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

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
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	// Parse response - different format for search vs list
	var rawRepos []struct {
		Name        string `json:"name"`
		FullName    string `json:"full_name"`
		Private     bool   `json:"private"`
		Description string `json:"description"`
	}

	if query != "" {
		// Search API wraps results in { items: [...] }
		var searchResult struct {
			Items []struct {
				Name        string `json:"name"`
				FullName    string `json:"full_name"`
				Private     bool   `json:"private"`
				Description string `json:"description"`
			} `json:"items"`
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
	sshPattern := regexp.MustCompile(`^[\w.-]+@[\w.-]+:[\w./-]+$`)
	if sshPattern.MatchString(rawURL) {
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
	pattern := regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$`)
	return pattern.MatchString(owner)
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
	// Remove x-access-token:TOKEN@ from URLs
	tokenPattern := regexp.MustCompile(`x-access-token:[^@]+@`)
	return tokenPattern.ReplaceAllString(msg, "")
}

// sanitizeGitOutput removes tokens from git output lines.
func sanitizeGitOutput(line string) string {
	return SanitizeGitError(line)
}
