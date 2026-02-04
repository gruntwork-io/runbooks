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
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Constants
// =============================================================================

// DefaultGitHubOAuthClientID is Gruntwork's registered OAuth App client ID.
// This is a public identifier (not a secret) used for the device flow.
// Users can override this with the oauthClientId prop if needed.
const DefaultGitHubOAuthClientID = "Ov23liDbtds8EmGws3np"

// GitHubAPIBaseURL is the base URL for GitHub API requests.
// Only github.com is supported for security reasons (no custom base URLs).
const GitHubAPIBaseURL = "https://api.github.com"

// GitHubOAuthBaseURL is the base URL for GitHub OAuth requests.
const GitHubOAuthBaseURL = "https://github.com"

// =============================================================================
// Types
// =============================================================================

// GitHubUserInfo represents information about a GitHub user
type GitHubUserInfo struct {
	Login     string `json:"login"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	Email     string `json:"email,omitempty"`
}

// GitHubValidateRequest represents the request to validate a GitHub token
type GitHubValidateRequest struct {
	Token string `json:"token"`
}

// GitHubTokenType indicates the type of GitHub token
type GitHubTokenType string

const (
	GitHubTokenTypeClassicPAT     GitHubTokenType = "classic_pat"
	GitHubTokenTypeFineGrainedPAT GitHubTokenType = "fine_grained_pat"
	GitHubTokenTypeOAuth          GitHubTokenType = "oauth"
	GitHubTokenTypeGitHubApp      GitHubTokenType = "github_app"
	GitHubTokenTypeUnknown        GitHubTokenType = "unknown"
)

// detectGitHubTokenType determines the type of GitHub token by its prefix
func detectGitHubTokenType(token string) GitHubTokenType {
	switch {
	case strings.HasPrefix(token, "github_pat_"):
		return GitHubTokenTypeFineGrainedPAT
	case strings.HasPrefix(token, "ghp_"):
		return GitHubTokenTypeClassicPAT
	case strings.HasPrefix(token, "gho_"):
		return GitHubTokenTypeOAuth
	case strings.HasPrefix(token, "ghs_"), strings.HasPrefix(token, "ghu_"):
		return GitHubTokenTypeGitHubApp
	default:
		return GitHubTokenTypeUnknown
	}
}

// GitHubValidateResponse represents the response from token validation
type GitHubValidateResponse struct {
	Valid     bool            `json:"valid"`
	User      *GitHubUserInfo `json:"user,omitempty"`
	Scopes    []string        `json:"scopes,omitempty"`
	TokenType GitHubTokenType `json:"tokenType,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// GitHubOAuthStartRequest represents the request to start OAuth device flow
type GitHubOAuthStartRequest struct {
	ClientID string   `json:"clientId,omitempty"`
	Scopes   []string `json:"scopes,omitempty"`
}

// GitHubOAuthStartResponse represents the response from starting OAuth
type GitHubOAuthStartResponse struct {
	DeviceCode      string `json:"deviceCode,omitempty"`
	UserCode        string `json:"userCode,omitempty"`
	VerificationURI string `json:"verificationUri,omitempty"`
	ExpiresIn       int    `json:"expiresIn,omitempty"`
	Interval        int    `json:"interval,omitempty"`
	Error           string `json:"error,omitempty"`
}

// GitHubOAuthPollRequest represents the request to poll for OAuth completion
type GitHubOAuthPollRequest struct {
	ClientID   string `json:"clientId"`
	DeviceCode string `json:"deviceCode"`
}

// GitHubOAuthPollStatus represents the status of an OAuth poll response
type GitHubOAuthPollStatus string

const (
	GitHubOAuthPollStatusPending  GitHubOAuthPollStatus = "pending"
	GitHubOAuthPollStatusComplete GitHubOAuthPollStatus = "complete"
	GitHubOAuthPollStatusExpired  GitHubOAuthPollStatus = "expired"
	GitHubOAuthPollStatusError    GitHubOAuthPollStatus = "error"
)

// GitHubOAuthPollResponse represents the response from OAuth polling
type GitHubOAuthPollResponse struct {
	Status      GitHubOAuthPollStatus `json:"status"`
	AccessToken string                `json:"accessToken,omitempty"`
	User        *GitHubUserInfo       `json:"user,omitempty"`
	Error       string                `json:"error,omitempty"`
	SlowDown    bool                  `json:"slowDown,omitempty"` // True if we got rate-limited
}

// GitHubEnvCredentialsRequest represents a request to read GitHub credentials from environment
type GitHubEnvCredentialsRequest struct {
	Prefix       string `json:"prefix"`
	EnvVar       string `json:"envVar"`
	GitHubAuthID string `json:"githubAuthId"`
}

// GitHubEnvCredentialsResponse represents the response from environment credential validation
type GitHubEnvCredentialsResponse struct {
	Found     bool            `json:"found"`
	Valid     bool            `json:"valid,omitempty"`
	User      *GitHubUserInfo `json:"user,omitempty"`
	Scopes    []string        `json:"scopes,omitempty"`
	TokenType GitHubTokenType `json:"tokenType,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// GitHubCliCredentialsResponse represents the response from GitHub CLI credential detection
type GitHubCliCredentialsResponse struct {
	User   *GitHubUserInfo `json:"user,omitempty"`
	Scopes []string        `json:"scopes,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// Found returns true if GitHub CLI credentials were successfully detected
func (r *GitHubCliCredentialsResponse) Found() bool {
	return r.User != nil && r.Error == ""
}

// HasRepoScope returns true if the detected credentials include the "repo" scope
func (r *GitHubCliCredentialsResponse) HasRepoScope() bool {
	for _, scope := range r.Scopes {
		if scope == "repo" {
			return true
		}
	}
	return false
}

// =============================================================================
// Handlers
// =============================================================================

// HandleGitHubValidate validates a GitHub token by calling the /user endpoint
func HandleGitHubValidate() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitHubValidateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitHubValidateResponse{
				Valid: false,
				Error: "Invalid request format",
			})
			return
		}

		if req.Token == "" {
			c.JSON(http.StatusBadRequest, GitHubValidateResponse{
				Valid: false,
				Error: "Token is required",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		user, scopes, err := validateGitHubToken(ctx, req.Token)
		if err != nil {
			c.JSON(http.StatusOK, GitHubValidateResponse{
				Valid: false,
				Error: err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, GitHubValidateResponse{
			Valid:     true,
			User:      user,
			Scopes:    scopes,
			TokenType: detectGitHubTokenType(req.Token),
		})
	}
}

// HandleGitHubOAuthStart initiates GitHub OAuth device authorization flow
func HandleGitHubOAuthStart() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitHubOAuthStartRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitHubOAuthStartResponse{
				Error: "Invalid request format",
			})
			return
		}

		// Use provided client ID or fall back to default
		clientID := req.ClientID
		if clientID == "" {
			clientID = DefaultGitHubOAuthClientID
		}

		if clientID == "" {
			c.JSON(http.StatusBadRequest, GitHubOAuthStartResponse{
				Error: "No OAuth client ID configured. Either provide oauthClientId prop or configure default client ID.",
			})
			return
		}

		// Default scopes if not specified
		scopes := req.Scopes
		if len(scopes) == 0 {
			scopes = []string{"repo"}
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// Start device flow
		deviceCode, err := startGitHubDeviceFlow(ctx, clientID, scopes)
		if err != nil {
			c.JSON(http.StatusOK, GitHubOAuthStartResponse{
				Error: fmt.Sprintf("Failed to start device flow: %v", err),
			})
			return
		}

		c.JSON(http.StatusOK, deviceCode)
	}
}

// HandleGitHubOAuthPoll polls for GitHub OAuth completion
// This is a protected endpoint that returns the access token
func HandleGitHubOAuthPoll() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitHubOAuthPollRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitHubOAuthPollResponse{
				Status: GitHubOAuthPollStatusError,
				Error:  "Invalid request format",
			})
			return
		}

		if req.ClientID == "" || req.DeviceCode == "" {
			c.JSON(http.StatusBadRequest, GitHubOAuthPollResponse{
				Status: GitHubOAuthPollStatusError,
				Error:  "ClientID and DeviceCode are required",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// Poll for token
		result, err := pollGitHubDeviceFlow(ctx, req.ClientID, req.DeviceCode)
		if err != nil {
			c.JSON(http.StatusOK, GitHubOAuthPollResponse{
				Status: GitHubOAuthPollStatusError,
				Error:  err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, result)
	}
}

// isAllowedGitHubEnvVar validates that an environment variable name is a permitted
// GitHub token variable for the default detection path. This prevents arbitrary
// env var probing when no specific envVar is requested.
// Allowed patterns:
//   - Exactly "GITHUB_TOKEN" or "GH_TOKEN"
//   - Prefixed variants like "PREFIX_GITHUB_TOKEN" or "MY_GH_TOKEN"
//
// The prefix must be uppercase letters, digits, or underscores, and the full name
// must end with either "GITHUB_TOKEN" or "GH_TOKEN".
func isAllowedGitHubEnvVar(name string) bool {
	if name == "" {
		return false
	}
	// Exact matches for standard names
	if name == "GITHUB_TOKEN" || name == "GH_TOKEN" {
		return true
	}
	// Check for prefixed variants - must end with _GITHUB_TOKEN or _GH_TOKEN
	// and prefix must be valid (uppercase alphanumeric + underscore)
	validPrefixPattern := regexp.MustCompile(`^[A-Z][A-Z0-9_]*_(GITHUB_TOKEN|GH_TOKEN)$`)
	return validPrefixPattern.MatchString(name)
}

// isValidEnvVarPrefix validates that a prefix is safe to use when constructing
// environment variable names. Must be empty or contain only uppercase letters,
// digits, and underscores, optionally ending with underscore.
func isValidEnvVarPrefix(prefix string) bool {
	if prefix == "" {
		return true
	}
	// Prefix must be uppercase alphanumeric with underscores
	// If non-empty, should typically end with underscore for clean naming
	validPrefix := regexp.MustCompile(`^[A-Z][A-Z0-9_]*_?$`)
	return validPrefix.MatchString(prefix)
}

// HandleGitHubEnvCredentials reads GitHub credentials from the process environment,
// validates them, and registers them to the session.
// Returns only user metadata - never returns raw credentials to the browser.
func HandleGitHubEnvCredentials(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitHubEnvCredentialsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitHubEnvCredentialsResponse{
				Found: false,
				Error: "Invalid request format",
			})
			return
		}

		// Determine which env var to read
		var token string
		// Validate the prefix before using it
		if !isValidEnvVarPrefix(req.Prefix) {
			c.JSON(http.StatusOK, GitHubEnvCredentialsResponse{
				Found: false,
				Error: "Invalid prefix: must be uppercase alphanumeric with underscores",
			})
			return
		}
		// Construct the env var names and validate them
		githubTokenName := req.Prefix + "GITHUB_TOKEN"
		ghTokenName := req.Prefix + "GH_TOKEN"

		// Double-check that constructed names are valid (defense in depth)
		if !isAllowedGitHubEnvVar(githubTokenName) || !isAllowedGitHubEnvVar(ghTokenName) {
			c.JSON(http.StatusOK, GitHubEnvCredentialsResponse{
				Found: false,
				Error: "Invalid prefix results in disallowed environment variable name",
			})
			return
		}

		// Try standard env var names with optional prefix
		token = os.Getenv(githubTokenName)
		if token == "" {
			token = os.Getenv(ghTokenName)
		}

		if token == "" {
			c.JSON(http.StatusOK, GitHubEnvCredentialsResponse{
				Found: false,
				Error: "GITHUB_TOKEN or GH_TOKEN not found in environment",
			})
			return
		}

		// Validate the token
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		user, scopes, err := validateGitHubToken(ctx, token)
		if err != nil {
			c.JSON(http.StatusOK, GitHubEnvCredentialsResponse{
				Found: true,
				Valid: false,
				Error: fmt.Sprintf("Token found but invalid: %v", err),
			})
			return
		}

		// Register token to session environment (server-side only)
		envVars := map[string]string{
			"GITHUB_TOKEN": token,
			"GITHUB_USER":  user.Login,
		}

		if err := sm.AppendToEnv(envVars); err != nil {
			c.JSON(http.StatusInternalServerError, GitHubEnvCredentialsResponse{
				Found: true,
				Valid: true,
				Error: "Failed to register credentials to session",
			})
			return
		}

		// Return only safe metadata - NEVER return raw token
		c.JSON(http.StatusOK, GitHubEnvCredentialsResponse{
			Found:     true,
			Valid:     true,
			User:      user,
			Scopes:    scopes,
			TokenType: detectGitHubTokenType(token),
		})
	}
}

// HandleGitHubCliCredentials detects GitHub credentials from the gh CLI,
// validates them, and registers them to the session.
// Returns user metadata and scopes - never returns raw credentials to the browser.
func HandleGitHubCliCredentials(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 1. Check if gh is installed
		ghPath, err := exec.LookPath("gh")
		if err != nil {
			c.JSON(http.StatusOK, GitHubCliCredentialsResponse{
				Error: "GitHub CLI (gh) is not installed",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// 2. Get token from gh auth token
		tokenCmd := exec.CommandContext(ctx, ghPath, "auth", "token")
		tokenOutput, err := tokenCmd.Output()
		if err != nil {
			c.JSON(http.StatusOK, GitHubCliCredentialsResponse{
				Error: "Not authenticated to GitHub CLI. Run 'gh auth login' to authenticate.",
			})
			return
		}
		token := strings.TrimSpace(string(tokenOutput))

		if token == "" {
			c.JSON(http.StatusOK, GitHubCliCredentialsResponse{
				Error: "GitHub CLI returned empty token",
			})
			return
		}

		// 3. Validate token and get user info via GitHub API
		// (We can't use `gh api user` because it requires GH_TOKEN or interactive terminal)
		user, _, err := validateGitHubToken(ctx, token)
		if err != nil {
			c.JSON(http.StatusOK, GitHubCliCredentialsResponse{
				Error: fmt.Sprintf("GitHub CLI token is invalid: %v", err),
			})
			return
		}

		// 4. Get scopes from gh auth status (more reliable than X-OAuth-Scopes header for CLI)
		statusCmd := exec.CommandContext(ctx, ghPath, "auth", "status")
		statusOutput, _ := statusCmd.CombinedOutput() // Ignore error, parse what we can
		scopes := parseGitHubCliScopes(string(statusOutput))

		// 5. Register credentials to session (server-side only, never return token)
		envVars := map[string]string{
			"GITHUB_TOKEN": token,
			"GITHUB_USER":  user.Login,
		}

		if err := sm.AppendToEnv(envVars); err != nil {
			c.JSON(http.StatusInternalServerError, GitHubCliCredentialsResponse{
				Error: "Failed to register credentials to session",
			})
			return
		}

		// Return only safe metadata - NEVER return raw token
		c.JSON(http.StatusOK, GitHubCliCredentialsResponse{
			User:   user,
			Scopes: scopes,
		})
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

// validateGitHubToken validates a GitHub token by calling the /user endpoint
// Returns user info, scopes (from X-OAuth-Scopes header), and any error
func validateGitHubToken(ctx context.Context, token string) (*GitHubUserInfo, []string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", GitHubAPIBaseURL+"/user", nil)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to call GitHub API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, nil, fmt.Errorf("invalid or expired token")
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	// Extract scopes from X-OAuth-Scopes header
	// Format: "repo, gist, read:org" (comma-separated)
	var scopes []string
	if scopeHeader := resp.Header.Get("X-OAuth-Scopes"); scopeHeader != "" {
		for _, s := range strings.Split(scopeHeader, ",") {
			scope := strings.TrimSpace(s)
			if scope != "" {
				scopes = append(scopes, scope)
			}
		}
	}

	var ghUser struct {
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
		Email     string `json:"email"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&ghUser); err != nil {
		return nil, nil, fmt.Errorf("failed to parse GitHub response: %w", err)
	}

	return &GitHubUserInfo{
		Login:     ghUser.Login,
		Name:      ghUser.Name,
		AvatarURL: ghUser.AvatarURL,
		Email:     ghUser.Email,
	}, scopes, nil
}

// startGitHubDeviceFlow initiates the OAuth device authorization flow
func startGitHubDeviceFlow(ctx context.Context, clientID string, scopes []string) (*GitHubOAuthStartResponse, error) {
	data := url.Values{}
	data.Set("client_id", clientID)
	data.Set("scope", strings.Join(scopes, " "))

	req, err := http.NewRequestWithContext(ctx, "POST", GitHubOAuthBaseURL+"/login/device/code", strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call GitHub: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitHub error (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
		Error           string `json:"error"`
		ErrorDesc       string `json:"error_description"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if result.Error != "" {
		return nil, fmt.Errorf("%s: %s", result.Error, result.ErrorDesc)
	}

	return &GitHubOAuthStartResponse{
		DeviceCode:      result.DeviceCode,
		UserCode:        result.UserCode,
		VerificationURI: result.VerificationURI,
		ExpiresIn:       result.ExpiresIn,
		Interval:        result.Interval,
	}, nil
}

// pollGitHubDeviceFlow polls for OAuth completion
func pollGitHubDeviceFlow(ctx context.Context, clientID, deviceCode string) (*GitHubOAuthPollResponse, error) {
	data := url.Values{}
	data.Set("client_id", clientID)
	data.Set("device_code", deviceCode)
	data.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")

	req, err := http.NewRequestWithContext(ctx, "POST", GitHubOAuthBaseURL+"/login/oauth/access_token", strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call GitHub: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	// Handle different error states
	switch result.Error {
	case "":
		// Success! We have a token. Now validate it to get user info.
		user, _, err := validateGitHubToken(ctx, result.AccessToken)
		if err != nil {
			return &GitHubOAuthPollResponse{
				Status:      GitHubOAuthPollStatusComplete,
				AccessToken: result.AccessToken,
				Error:       fmt.Sprintf("Token obtained but failed to get user info: %v", err),
			}, nil
		}
		return &GitHubOAuthPollResponse{
			Status:      GitHubOAuthPollStatusComplete,
			AccessToken: result.AccessToken,
			User:        user,
		}, nil

	case "authorization_pending":
		// User hasn't authorized yet
		return &GitHubOAuthPollResponse{
			Status: GitHubOAuthPollStatusPending,
		}, nil

	case "slow_down":
		// We're polling too fast - client should increase interval
		return &GitHubOAuthPollResponse{
			Status:   GitHubOAuthPollStatusPending,
			SlowDown: true,
		}, nil

	case "expired_token":
		// Device code expired
		return &GitHubOAuthPollResponse{
			Status: GitHubOAuthPollStatusExpired,
			Error:  "Authorization request expired. Please try again.",
		}, nil

	case "access_denied":
		// User denied the request
		return &GitHubOAuthPollResponse{
			Status: GitHubOAuthPollStatusError,
			Error:  "Authorization was denied by the user.",
		}, nil

	default:
		// Other error
		return &GitHubOAuthPollResponse{
			Status: GitHubOAuthPollStatusError,
			Error:  fmt.Sprintf("%s: %s", result.Error, result.ErrorDesc),
		}, nil
	}
}

// IsDefaultGitHubOAuthClientID checks if the given client ID is the default Gruntwork app
func IsDefaultGitHubOAuthClientID(clientID string) bool {
	return clientID == "" || clientID == DefaultGitHubOAuthClientID
}

// parseGitHubCliScopes parses OAuth scopes from gh auth status output
// Example output line: "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'"
func parseGitHubCliScopes(statusOutput string) []string {
	// Look for "Token scopes:" line and capture everything after it to end of line
	scopeRegex := regexp.MustCompile(`Token scopes?:\s*(.+)`)
	matches := scopeRegex.FindStringSubmatch(statusOutput)
	if len(matches) < 2 {
		return nil
	}

	// Parse comma-separated scopes, removing quotes
	scopeStr := matches[1]
	var scopes []string
	for _, s := range strings.Split(scopeStr, ",") {
		scope := strings.TrimSpace(s)
		scope = strings.Trim(scope, "'\"")
		if scope != "" {
			scopes = append(scopes, scope)
		}
	}
	return scopes
}
