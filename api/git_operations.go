package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Types
// =============================================================================

// GitHubRepoInfoAPI represents repository info from GitHub API (snake_case)
type GitHubRepoInfoAPI struct {
	ID            int    `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	Description   string `json:"description"`
	DefaultBranch string `json:"default_branch"`
	Private       bool   `json:"private"`
	HTMLURL       string `json:"html_url"`
	CloneURL      string `json:"clone_url"`
}

// GitHubRepoInfo represents repository info for frontend (camelCase)
type GitHubRepoInfo struct {
	ID            int    `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"fullName"`
	Description   string `json:"description"`
	DefaultBranch string `json:"defaultBranch"`
	Private       bool   `json:"private"`
	HTMLURL       string `json:"htmlUrl"`
	CloneURL      string `json:"cloneUrl"`
}

// GitHubBranchInfo represents branch info from GitHub API
type GitHubBranchInfo struct {
	Name      string `json:"name"`
	Protected bool   `json:"protected"`
}

// ListReposResponse represents the response for listing repos
type ListReposResponse struct {
	Repos []GitHubRepoInfo `json:"repos"`
	Error string           `json:"error,omitempty"`
}

// ListBranchesResponse represents the response for listing branches
type ListBranchesResponse struct {
	Branches      []GitHubBranchInfo `json:"branches"`
	DefaultBranch string             `json:"defaultBranch,omitempty"`
	Error         string             `json:"error,omitempty"`
}

// GitCloneRequest represents the request to clone a repository
type GitCloneRequest struct {
	Repo          string `json:"repo"`          // owner/repo format
	Branch        string `json:"branch"`        // Branch to clone
	WorkspacePath string `json:"workspacePath"` // Optional subdirectory
}

// GitCloneResponse represents the response from cloning
type GitCloneResponse struct {
	WorkspacePath string `json:"workspacePath,omitempty"`
	CommitSHA     string `json:"commitSha,omitempty"`
	Error         string `json:"error,omitempty"`
}

// GitStatusResponse represents the response from git status
type GitStatusResponse struct {
	Clean    bool             `json:"clean"`
	Files    []GitFileStatus  `json:"files"`
	Ahead    int              `json:"ahead"`
	Behind   int              `json:"behind"`
	Branch   string           `json:"branch"`
	Error    string           `json:"error,omitempty"`
}

// GitFileStatus represents the status of a single file
type GitFileStatus struct {
	Path      string `json:"path"`
	Status    string `json:"status"` // "added", "modified", "deleted", "renamed", "untracked"
	OldPath   string `json:"oldPath,omitempty"` // For renamed files
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// GitDiffRequest represents the request for getting diffs
type GitDiffRequest struct {
	WorkspacePath string `json:"workspacePath"`
	FilePath      string `json:"filePath,omitempty"` // Empty for full diff
}

// GitDiffResponse represents the response with diff content
type GitDiffResponse struct {
	Diff  string `json:"diff"`
	Error string `json:"error,omitempty"`
}

// =============================================================================
// GitHub API Handlers
// =============================================================================

// HandleListRepos lists repositories for the authenticated user
func HandleListRepos(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := GetGitHubToken(sessionManager)
		if token == "" {
			c.JSON(http.StatusUnauthorized, ListReposResponse{
				Error: "GitHub token not found",
			})
			return
		}

		// Fetch user's repos from GitHub
		resp, err := GitHubAPIRequest("GET", "/user/repos?sort=updated&per_page=100", token, nil)
		if err != nil {
			c.JSON(http.StatusInternalServerError, ListReposResponse{
				Error: fmt.Sprintf("Failed to fetch repositories: %v", err),
			})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			c.JSON(http.StatusInternalServerError, ListReposResponse{
				Error: fmt.Sprintf("GitHub API error: %s", string(body)),
			})
			return
		}

		var apiRepos []GitHubRepoInfoAPI
		if err := json.NewDecoder(resp.Body).Decode(&apiRepos); err != nil {
			c.JSON(http.StatusInternalServerError, ListReposResponse{
				Error: fmt.Sprintf("Failed to parse response: %v", err),
			})
			return
		}

		// Convert to frontend format (camelCase)
		repos := make([]GitHubRepoInfo, len(apiRepos))
		for i, r := range apiRepos {
			repos[i] = GitHubRepoInfo{
				ID:            r.ID,
				Name:          r.Name,
				FullName:      r.FullName,
				Description:   r.Description,
				DefaultBranch: r.DefaultBranch,
				Private:       r.Private,
				HTMLURL:       r.HTMLURL,
				CloneURL:      r.CloneURL,
			}
		}

		c.JSON(http.StatusOK, ListReposResponse{
			Repos: repos,
		})
	}
}

// HandleListBranches lists branches for a repository
func HandleListBranches(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		owner := c.Param("owner")
		repo := c.Param("repo")

		if owner == "" || repo == "" {
			c.JSON(http.StatusBadRequest, ListBranchesResponse{
				Error: "Owner and repo are required",
			})
			return
		}

		token := GetGitHubToken(sessionManager)
		if token == "" {
			c.JSON(http.StatusUnauthorized, ListBranchesResponse{
				Error: "GitHub token not found",
			})
			return
		}

		// Fetch branches
		resp, err := GitHubAPIRequest("GET", fmt.Sprintf("/repos/%s/%s/branches?per_page=100", owner, repo), token, nil)
		if err != nil {
			c.JSON(http.StatusInternalServerError, ListBranchesResponse{
				Error: fmt.Sprintf("Failed to fetch branches: %v", err),
			})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			c.JSON(http.StatusInternalServerError, ListBranchesResponse{
				Error: fmt.Sprintf("GitHub API error: %s", string(body)),
			})
			return
		}

		var branches []GitHubBranchInfo
		if err := json.NewDecoder(resp.Body).Decode(&branches); err != nil {
			c.JSON(http.StatusInternalServerError, ListBranchesResponse{
				Error: fmt.Sprintf("Failed to parse response: %v", err),
			})
			return
		}

		// Get default branch info
		repoResp, err := GitHubAPIRequest("GET", fmt.Sprintf("/repos/%s/%s", owner, repo), token, nil)
		defaultBranch := ""
		if err == nil {
			defer repoResp.Body.Close()
			var repoInfo GitHubRepoInfo
			if json.NewDecoder(repoResp.Body).Decode(&repoInfo) == nil {
				defaultBranch = repoInfo.DefaultBranch
			}
		}

		c.JSON(http.StatusOK, ListBranchesResponse{
			Branches:      branches,
			DefaultBranch: defaultBranch,
		})
	}
}

// =============================================================================
// Git Operations Handlers
// =============================================================================

// HandleGitClone clones a repository
func HandleGitClone(sessionManager *SessionManager, outputPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitCloneRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitCloneResponse{
				Error: "Invalid request body",
			})
			return
		}

		if req.Repo == "" {
			c.JSON(http.StatusBadRequest, GitCloneResponse{
				Error: "Repository is required",
			})
			return
		}

		if req.Branch == "" {
			c.JSON(http.StatusBadRequest, GitCloneResponse{
				Error: "Branch is required",
			})
			return
		}

		token := GetGitHubToken(sessionManager)
		if token == "" {
			c.JSON(http.StatusUnauthorized, GitCloneResponse{
				Error: "GitHub token not found",
			})
			return
		}

		// Determine workspace path
		workspacePath := req.WorkspacePath
		if workspacePath == "" {
			// Use repo name as default
			parts := strings.Split(req.Repo, "/")
			if len(parts) == 2 {
				workspacePath = parts[1]
			} else {
				workspacePath = "workspace"
			}
		}

		// Validate path (security: prevent directory traversal)
		if strings.Contains(workspacePath, "..") || strings.HasPrefix(workspacePath, "/") {
			c.JSON(http.StatusBadRequest, GitCloneResponse{
				Error: "Invalid workspace path",
			})
			return
		}

		// Full path for the workspace
		fullPath := filepath.Join(outputPath, "git-workspaces", workspacePath)

		// Clean up existing directory if it exists
		if _, err := os.Stat(fullPath); err == nil {
			if err := os.RemoveAll(fullPath); err != nil {
				c.JSON(http.StatusInternalServerError, GitCloneResponse{
					Error: fmt.Sprintf("Failed to clean existing workspace: %v", err),
				})
				return
			}
		}

		// Create parent directory
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			c.JSON(http.StatusInternalServerError, GitCloneResponse{
				Error: fmt.Sprintf("Failed to create workspace directory: %v", err),
			})
			return
		}

		// Build clone URL with token for authentication
		cloneURL := fmt.Sprintf("https://x-access-token:%s@github.com/%s.git", token, req.Repo)

		// Clone using git command (more reliable than go-git for HTTPS with tokens)
		cmd := exec.Command("git", "clone", "--branch", req.Branch, "--single-branch", "--depth", "1", cloneURL, fullPath)
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")

		output, err := cmd.CombinedOutput()
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitCloneResponse{
				Error: fmt.Sprintf("Clone failed: %v - %s", err, sanitizeGitOutput(string(output), token)),
			})
			return
		}

		// Get the HEAD commit SHA
		commitSHA, err := getGitHeadSHA(fullPath)
		if err != nil {
			// Clone succeeded, but we couldn't get the SHA - not a fatal error
			commitSHA = "unknown"
		}

		// Fetch all history for the branch (we need full history for diffs)
		unshallowCmd := exec.Command("git", "fetch", "--unshallow")
		unshallowCmd.Dir = fullPath
		unshallowCmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		_ = unshallowCmd.Run() // Ignore error - may fail if already complete

		c.JSON(http.StatusOK, GitCloneResponse{
			WorkspacePath: fullPath,
			CommitSHA:     commitSHA,
		})
	}
}

// HandleGitStatus gets the status of a git workspace
func HandleGitStatus(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		workspacePath := c.Query("path")
		if workspacePath == "" {
			c.JSON(http.StatusBadRequest, GitStatusResponse{
				Error: "Workspace path is required",
			})
			return
		}

		// Validate path exists and is a git repo
		if _, err := os.Stat(filepath.Join(workspacePath, ".git")); os.IsNotExist(err) {
			c.JSON(http.StatusBadRequest, GitStatusResponse{
				Error: "Not a git repository",
			})
			return
		}

		// Get current branch
		branchCmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
		branchCmd.Dir = workspacePath
		branchOutput, err := branchCmd.Output()
		branch := "unknown"
		if err == nil {
			branch = strings.TrimSpace(string(branchOutput))
		}

		// Get status with porcelain format
		statusCmd := exec.Command("git", "status", "--porcelain=v1")
		statusCmd.Dir = workspacePath
		statusOutput, err := statusCmd.Output()
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitStatusResponse{
				Error: fmt.Sprintf("Failed to get status: %v", err),
			})
			return
		}

		// Parse status output
		files := parseGitStatus(string(statusOutput))

		c.JSON(http.StatusOK, GitStatusResponse{
			Clean:  len(files) == 0,
			Files:  files,
			Branch: branch,
		})
	}
}

// HandleGitDiff gets the diff for a workspace or specific file
func HandleGitDiff(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitDiffRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitDiffResponse{
				Error: "Invalid request body",
			})
			return
		}

		if req.WorkspacePath == "" {
			c.JSON(http.StatusBadRequest, GitDiffResponse{
				Error: "Workspace path is required",
			})
			return
		}

		// Build diff command
		args := []string{"diff", "--no-color"}
		if req.FilePath != "" {
			args = append(args, "--", req.FilePath)
		}

		diffCmd := exec.Command("git", args...)
		diffCmd.Dir = req.WorkspacePath
		diffOutput, err := diffCmd.Output()
		if err != nil {
			// Check if it's just "no diff" vs actual error
			exitErr, ok := err.(*exec.ExitError)
			if ok && len(exitErr.Stderr) == 0 {
				// No diff, empty output is fine
				c.JSON(http.StatusOK, GitDiffResponse{Diff: ""})
				return
			}
			c.JSON(http.StatusInternalServerError, GitDiffResponse{
				Error: fmt.Sprintf("Failed to get diff: %v", err),
			})
			return
		}

		c.JSON(http.StatusOK, GitDiffResponse{
			Diff: string(diffOutput),
		})
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

// getGitHeadSHA gets the HEAD commit SHA for a repository
func getGitHeadSHA(repoPath string) (string, error) {
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = repoPath
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

// sanitizeGitOutput removes tokens from git output for error messages
func sanitizeGitOutput(output, token string) string {
	if token != "" {
		output = strings.ReplaceAll(output, token, "[REDACTED]")
	}
	return output
}

// parseGitStatus parses git status --porcelain output
func parseGitStatus(output string) []GitFileStatus {
	var files []GitFileStatus
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		if len(line) < 3 {
			continue
		}

		status := line[:2]
		path := strings.TrimSpace(line[3:])

		var fileStatus GitFileStatus
		fileStatus.Path = path

		// Parse status codes
		// First character is index status, second is working tree status
		indexStatus := status[0]
		workTreeStatus := status[1]

		switch {
		case indexStatus == 'A' || workTreeStatus == 'A':
			fileStatus.Status = "added"
		case indexStatus == 'M' || workTreeStatus == 'M':
			fileStatus.Status = "modified"
		case indexStatus == 'D' || workTreeStatus == 'D':
			fileStatus.Status = "deleted"
		case indexStatus == 'R' || workTreeStatus == 'R':
			fileStatus.Status = "renamed"
			// Handle renamed files (old -> new format)
			if parts := strings.Split(path, " -> "); len(parts) == 2 {
				fileStatus.OldPath = parts[0]
				fileStatus.Path = parts[1]
			}
		case status == "??":
			fileStatus.Status = "untracked"
		default:
			fileStatus.Status = "modified"
		}

		files = append(files, fileStatus)
	}

	return files
}

// GetWorkspaceFileTree builds a file tree for a git workspace
func GetWorkspaceFileTree(workspacePath string) ([]FileTreeNode, error) {
	return buildFileTreeWithRoot(workspacePath, "")
}

// HandleGitWorkspaceFiles returns the file tree for a git workspace
func HandleGitWorkspaceFiles(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		workspacePath := c.Query("path")
		if workspacePath == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "Workspace path is required",
			})
			return
		}

		// Validate path exists
		if _, err := os.Stat(workspacePath); os.IsNotExist(err) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "Workspace path does not exist",
			})
			return
		}

		// Get file tree
		fileTree, err := GetWorkspaceFileTree(workspacePath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": fmt.Sprintf("Failed to get file tree: %v", err),
			})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"files": fileTree,
		})
	}
}
