package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Types
// =============================================================================

// GitBranchRequest represents the request to create a branch
type GitBranchRequest struct {
	WorkspacePath string `json:"workspacePath"`
	BranchName    string `json:"branchName"`
}

// GitBranchResponse represents the response from branch creation
type GitBranchResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// GitCommitRequest represents the request to create a commit
type GitCommitRequest struct {
	WorkspacePath string `json:"workspacePath"`
	Message       string `json:"message"`
}

// GitCommitResponse represents the response from commit creation
type GitCommitResponse struct {
	CommitSHA string `json:"commitSha,omitempty"`
	Error     string `json:"error,omitempty"`
}

// GitPushRequest represents the request to push changes
type GitPushRequest struct {
	WorkspacePath string `json:"workspacePath"`
	BranchName    string `json:"branchName"`
}

// GitPushResponse represents the response from push
type GitPushResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// GitHubPRRequest represents the request to create a PR
type GitHubPRRequest struct {
	Repo   string `json:"repo"`   // owner/repo
	Head   string `json:"head"`   // Branch to merge
	Base   string `json:"base"`   // Target branch
	Title  string `json:"title"`
	Body   string `json:"body"`
	Draft  bool   `json:"draft"`
}

// GitHubPRResponse represents the response from PR creation
type GitHubPRResponse struct {
	HTMLURL string `json:"htmlUrl,omitempty"`
	Number  int    `json:"number,omitempty"`
	Error   string `json:"error,omitempty"`
}

// =============================================================================
// Handlers
// =============================================================================

// HandleGitBranch creates a new branch
func HandleGitBranch(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitBranchRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitBranchResponse{
				Error: "Invalid request body",
			})
			return
		}

		if req.WorkspacePath == "" || req.BranchName == "" {
			c.JSON(http.StatusBadRequest, GitBranchResponse{
				Error: "Workspace path and branch name are required",
			})
			return
		}

		// Validate branch name (basic security check)
		if strings.Contains(req.BranchName, "..") || strings.Contains(req.BranchName, " ") {
			c.JSON(http.StatusBadRequest, GitBranchResponse{
				Error: "Invalid branch name",
			})
			return
		}

		// Create and checkout the branch
		cmd := exec.Command("git", "checkout", "-b", req.BranchName)
		cmd.Dir = req.WorkspacePath

		output, err := cmd.CombinedOutput()
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitBranchResponse{
				Error: fmt.Sprintf("Failed to create branch: %s", string(output)),
			})
			return
		}

		c.JSON(http.StatusOK, GitBranchResponse{
			Success: true,
		})
	}
}

// HandleGitCommit stages all changes and creates a commit
func HandleGitCommit(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitCommitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitCommitResponse{
				Error: "Invalid request body",
			})
			return
		}

		if req.WorkspacePath == "" || req.Message == "" {
			c.JSON(http.StatusBadRequest, GitCommitResponse{
				Error: "Workspace path and message are required",
			})
			return
		}

		// Configure git user if not set (required for commits)
		// Use generic values that will be overwritten by the push
		configCmd := exec.Command("git", "config", "user.email", "runbook@localhost")
		configCmd.Dir = req.WorkspacePath
		_ = configCmd.Run()

		configCmd = exec.Command("git", "config", "user.name", "Runbook")
		configCmd.Dir = req.WorkspacePath
		_ = configCmd.Run()

		// Stage all changes
		addCmd := exec.Command("git", "add", "-A")
		addCmd.Dir = req.WorkspacePath

		output, err := addCmd.CombinedOutput()
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitCommitResponse{
				Error: fmt.Sprintf("Failed to stage changes: %s", string(output)),
			})
			return
		}

		// Create commit
		commitCmd := exec.Command("git", "commit", "-m", req.Message)
		commitCmd.Dir = req.WorkspacePath

		output, err = commitCmd.CombinedOutput()
		if err != nil {
			// Check if there's nothing to commit
			if strings.Contains(string(output), "nothing to commit") {
				c.JSON(http.StatusBadRequest, GitCommitResponse{
					Error: "Nothing to commit",
				})
				return
			}
			c.JSON(http.StatusInternalServerError, GitCommitResponse{
				Error: fmt.Sprintf("Failed to commit: %s", string(output)),
			})
			return
		}

		// Get the commit SHA
		sha, err := getGitHeadSHA(req.WorkspacePath)
		if err != nil {
			sha = "unknown"
		}

		c.JSON(http.StatusOK, GitCommitResponse{
			CommitSHA: sha,
		})
	}
}

// HandleGitPush pushes the branch to remote
func HandleGitPush(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitPushRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitPushResponse{
				Error: "Invalid request body",
			})
			return
		}

		if req.WorkspacePath == "" || req.BranchName == "" {
			c.JSON(http.StatusBadRequest, GitPushResponse{
				Error: "Workspace path and branch name are required",
			})
			return
		}

		token := GetGitHubToken(sessionManager)
		if token == "" {
			c.JSON(http.StatusUnauthorized, GitPushResponse{
				Error: "GitHub token not found",
			})
			return
		}

		// Get the remote URL and update it with the token
		remoteCmd := exec.Command("git", "remote", "get-url", "origin")
		remoteCmd.Dir = req.WorkspacePath
		remoteOutput, err := remoteCmd.Output()
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitPushResponse{
				Error: "Failed to get remote URL",
			})
			return
		}

		remoteURL := strings.TrimSpace(string(remoteOutput))
		
		// Convert SSH URL to HTTPS if needed and add token
		if strings.HasPrefix(remoteURL, "git@github.com:") {
			remoteURL = strings.Replace(remoteURL, "git@github.com:", "https://github.com/", 1)
		}
		
		// Add token to URL
		if strings.HasPrefix(remoteURL, "https://") {
			remoteURL = strings.Replace(remoteURL, "https://", fmt.Sprintf("https://x-access-token:%s@", token), 1)
		}

		// Push using the authenticated URL
		pushCmd := exec.Command("git", "push", remoteURL, req.BranchName)
		pushCmd.Dir = req.WorkspacePath

		output, err := pushCmd.CombinedOutput()
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitPushResponse{
				Error: fmt.Sprintf("Failed to push: %s", sanitizeGitOutput(string(output), token)),
			})
			return
		}

		c.JSON(http.StatusOK, GitPushResponse{
			Success: true,
		})
	}
}

// HandleGitHubCreatePR creates a pull request via GitHub API
func HandleGitHubCreatePR(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitHubPRRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitHubPRResponse{
				Error: "Invalid request body",
			})
			return
		}

		if req.Repo == "" || req.Head == "" || req.Base == "" || req.Title == "" {
			c.JSON(http.StatusBadRequest, GitHubPRResponse{
				Error: "Repo, head, base, and title are required",
			})
			return
		}

		token := GetGitHubToken(sessionManager)
		if token == "" {
			c.JSON(http.StatusUnauthorized, GitHubPRResponse{
				Error: "GitHub token not found",
			})
			return
		}

		// Create PR via GitHub API
		prBody := map[string]interface{}{
			"title": req.Title,
			"head":  req.Head,
			"base":  req.Base,
			"body":  req.Body,
			"draft": req.Draft,
		}

		resp, err := GitHubAPIRequest("POST", fmt.Sprintf("/repos/%s/pulls", req.Repo), token, prBody)
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitHubPRResponse{
				Error: fmt.Sprintf("Failed to create PR: %v", err),
			})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusCreated {
			var errResp struct {
				Message string `json:"message"`
				Errors  []struct {
					Message string `json:"message"`
				} `json:"errors"`
			}
			if err := decodeJSON(resp.Body, &errResp); err == nil {
				errMsg := errResp.Message
				if len(errResp.Errors) > 0 {
					errMsg = errResp.Errors[0].Message
				}
				c.JSON(http.StatusInternalServerError, GitHubPRResponse{
					Error: fmt.Sprintf("GitHub API error: %s", errMsg),
				})
				return
			}
			c.JSON(http.StatusInternalServerError, GitHubPRResponse{
				Error: fmt.Sprintf("GitHub API error: status %d", resp.StatusCode),
			})
			return
		}

		var prResp struct {
			HTMLURL string `json:"html_url"`
			Number  int    `json:"number"`
		}
		if err := decodeJSON(resp.Body, &prResp); err != nil {
			c.JSON(http.StatusInternalServerError, GitHubPRResponse{
				Error: "Failed to parse PR response",
			})
			return
		}

		c.JSON(http.StatusOK, GitHubPRResponse{
			HTMLURL: prResp.HTMLURL,
			Number:  prResp.Number,
		})
	}
}

// Helper to decode JSON
func decodeJSON(r io.Reader, v interface{}) error {
	return json.NewDecoder(r).Decode(v)
}
