package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Types
// =============================================================================

// GitHubValidateRequest represents the request to validate a GitHub token
type GitHubValidateRequest struct {
	Token string `json:"token"`
}

// GitHubValidateResponse represents the response from token validation
type GitHubValidateResponse struct {
	Valid     bool   `json:"valid"`
	Login     string `json:"login,omitempty"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	Email     string `json:"email,omitempty"`
	Error     string `json:"error,omitempty"`
}

// GitHubEnvRequest represents the request to check for env var token
type GitHubEnvRequest struct {
	GitHubAuthID string `json:"githubAuthId"`
}

// GitHubEnvResponse represents the response from env var check
type GitHubEnvResponse struct {
	Found     bool   `json:"found"`
	Valid     bool   `json:"valid,omitempty"`
	Login     string `json:"login,omitempty"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	Email     string `json:"email,omitempty"`
	Error     string `json:"error,omitempty"`
}

// GitHubTokenRequest represents the request to store a token
type GitHubTokenRequest struct {
	Token        string `json:"token"`
	GitHubAuthID string `json:"githubAuthId"`
}

// GitHubDeviceStartRequest represents the request to start device flow
type GitHubDeviceStartRequest struct {
	Scopes []string `json:"scopes"`
}

// GitHubDeviceStartResponse represents the response from starting device flow
type GitHubDeviceStartResponse struct {
	DeviceCode      string `json:"deviceCode,omitempty"`
	UserCode        string `json:"userCode,omitempty"`
	VerificationURI string `json:"verificationUri,omitempty"`
	ExpiresIn       int    `json:"expiresIn,omitempty"`
	Interval        int    `json:"interval,omitempty"`
	Error           string `json:"error,omitempty"`
}

// GitHubDevicePollRequest represents the request to poll device flow
type GitHubDevicePollRequest struct {
	DeviceCode   string `json:"deviceCode"`
	GitHubAuthID string `json:"githubAuthId"`
}

// GitHubDevicePollResponse represents the response from polling device flow
type GitHubDevicePollResponse struct {
	Status    string `json:"status"` // "pending", "success", "error"
	Login     string `json:"login,omitempty"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	Email     string `json:"email,omitempty"`
	Error     string `json:"error,omitempty"`
}

// GitHubUser represents a GitHub user from the API
type GitHubUser struct {
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	Email     string `json:"email"`
}

// GitHub OAuth App credentials for device flow
// To enable device flow authentication, set the GITHUB_OAUTH_CLIENT_ID environment variable
// You can create an OAuth App at: https://github.com/settings/developers
// The app needs "Device authorization flow" enabled in its settings
var githubClientID = ""

func init() {
	// Check for configured OAuth App client ID
	if clientID := os.Getenv("GITHUB_OAUTH_CLIENT_ID"); clientID != "" {
		githubClientID = clientID
	}
}

// =============================================================================
// Handlers
// =============================================================================

// HandleGitHubValidate validates a GitHub personal access token
func HandleGitHubValidate() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitHubValidateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitHubValidateResponse{
				Valid: false,
				Error: "Invalid request body",
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

		user, err := validateGitHubToken(req.Token)
		if err != nil {
			c.JSON(http.StatusOK, GitHubValidateResponse{
				Valid: false,
				Error: err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, GitHubValidateResponse{
			Valid:     true,
			Login:     user.Login,
			Name:      user.Name,
			AvatarURL: user.AvatarURL,
			Email:     user.Email,
		})
	}
}

// HandleGitHubEnvCredentials checks for GITHUB_TOKEN in environment
func HandleGitHubEnvCredentials(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitHubEnvRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitHubEnvResponse{
				Found: false,
				Error: "Invalid request body",
			})
			return
		}

		// Check for GITHUB_TOKEN in environment
		token := os.Getenv("GITHUB_TOKEN")
		if token == "" {
			// Also check GH_TOKEN (used by GitHub CLI)
			token = os.Getenv("GH_TOKEN")
		}

		if token == "" {
			c.JSON(http.StatusOK, GitHubEnvResponse{
				Found: false,
			})
			return
		}

		// Validate the token
		user, err := validateGitHubToken(token)
		if err != nil {
			c.JSON(http.StatusOK, GitHubEnvResponse{
				Found: true,
				Valid: false,
				Error: err.Error(),
			})
			return
		}

		// Store token in session
		sessionManager.AppendToEnv(map[string]string{
			"GITHUB_TOKEN": token,
		})

		c.JSON(http.StatusOK, GitHubEnvResponse{
			Found:     true,
			Valid:     true,
			Login:     user.Login,
			Name:      user.Name,
			AvatarURL: user.AvatarURL,
			Email:     user.Email,
		})
	}
}

// HandleGitHubStoreToken stores a GitHub token in the session
func HandleGitHubStoreToken(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitHubTokenRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
			return
		}

		if req.Token == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Token is required"})
			return
		}

		// Store token in session environment
		sessionManager.AppendToEnv(map[string]string{
			"GITHUB_TOKEN": req.Token,
		})

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// HandleGitHubDeviceStart starts the GitHub device flow
func HandleGitHubDeviceStart() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Check if OAuth App is configured
		if githubClientID == "" {
			c.JSON(http.StatusOK, GitHubDeviceStartResponse{
				Error: "Device flow not configured. Please use a Personal Access Token instead, or set GITHUB_OAUTH_CLIENT_ID environment variable.",
			})
			return
		}

		var req GitHubDeviceStartRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitHubDeviceStartResponse{
				Error: "Invalid request body",
			})
			return
		}

		scopes := req.Scopes
		if len(scopes) == 0 {
			scopes = []string{"repo"}
		}

		// Call GitHub's device authorization endpoint
		data := url.Values{}
		data.Set("client_id", githubClientID)
		data.Set("scope", strings.Join(scopes, " "))

		httpReq, err := http.NewRequest("POST", "https://github.com/login/device/code", strings.NewReader(data.Encode()))
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitHubDeviceStartResponse{
				Error: "Failed to create request",
			})
			return
		}

		httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		httpReq.Header.Set("Accept", "application/json")

		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(httpReq)
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitHubDeviceStartResponse{
				Error: fmt.Sprintf("Failed to contact GitHub: %v", err),
			})
			return
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitHubDeviceStartResponse{
				Error: "Failed to read response",
			})
			return
		}

		var deviceResp struct {
			DeviceCode      string `json:"device_code"`
			UserCode        string `json:"user_code"`
			VerificationURI string `json:"verification_uri"`
			ExpiresIn       int    `json:"expires_in"`
			Interval        int    `json:"interval"`
			Error           string `json:"error"`
			ErrorDesc       string `json:"error_description"`
		}

		if err := json.Unmarshal(body, &deviceResp); err != nil {
			c.JSON(http.StatusInternalServerError, GitHubDeviceStartResponse{
				Error: "Failed to parse response",
			})
			return
		}

		if deviceResp.Error != "" {
			c.JSON(http.StatusOK, GitHubDeviceStartResponse{
				Error: deviceResp.ErrorDesc,
			})
			return
		}

		c.JSON(http.StatusOK, GitHubDeviceStartResponse{
			DeviceCode:      deviceResp.DeviceCode,
			UserCode:        deviceResp.UserCode,
			VerificationURI: deviceResp.VerificationURI,
			ExpiresIn:       deviceResp.ExpiresIn,
			Interval:        deviceResp.Interval,
		})
	}
}

// HandleGitHubDevicePoll polls for device flow completion
func HandleGitHubDevicePoll(sessionManager *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req GitHubDevicePollRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GitHubDevicePollResponse{
				Status: "error",
				Error:  "Invalid request body",
			})
			return
		}

		// Poll GitHub for token
		data := url.Values{}
		data.Set("client_id", githubClientID)
		data.Set("device_code", req.DeviceCode)
		data.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")

		httpReq, err := http.NewRequest("POST", "https://github.com/login/oauth/access_token", strings.NewReader(data.Encode()))
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitHubDevicePollResponse{
				Status: "error",
				Error:  "Failed to create request",
			})
			return
		}

		httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		httpReq.Header.Set("Accept", "application/json")

		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(httpReq)
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitHubDevicePollResponse{
				Status: "error",
				Error:  fmt.Sprintf("Failed to contact GitHub: %v", err),
			})
			return
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			c.JSON(http.StatusInternalServerError, GitHubDevicePollResponse{
				Status: "error",
				Error:  "Failed to read response",
			})
			return
		}

		var tokenResp struct {
			AccessToken string `json:"access_token"`
			TokenType   string `json:"token_type"`
			Scope       string `json:"scope"`
			Error       string `json:"error"`
			ErrorDesc   string `json:"error_description"`
		}

		if err := json.Unmarshal(body, &tokenResp); err != nil {
			c.JSON(http.StatusInternalServerError, GitHubDevicePollResponse{
				Status: "error",
				Error:  "Failed to parse response",
			})
			return
		}

		// Check for pending authorization
		if tokenResp.Error == "authorization_pending" {
			c.JSON(http.StatusOK, GitHubDevicePollResponse{
				Status: "pending",
			})
			return
		}

		// Check for slow down request
		if tokenResp.Error == "slow_down" {
			c.JSON(http.StatusOK, GitHubDevicePollResponse{
				Status: "pending",
			})
			return
		}

		// Check for other errors
		if tokenResp.Error != "" {
			c.JSON(http.StatusOK, GitHubDevicePollResponse{
				Status: "error",
				Error:  tokenResp.ErrorDesc,
			})
			return
		}

		// Got the token, validate and get user info
		if tokenResp.AccessToken == "" {
			c.JSON(http.StatusOK, GitHubDevicePollResponse{
				Status: "error",
				Error:  "No access token received",
			})
			return
		}

		user, err := validateGitHubToken(tokenResp.AccessToken)
		if err != nil {
			c.JSON(http.StatusOK, GitHubDevicePollResponse{
				Status: "error",
				Error:  err.Error(),
			})
			return
		}

		// Store token in session
		sessionManager.AppendToEnv(map[string]string{
			"GITHUB_TOKEN": tokenResp.AccessToken,
		})

		c.JSON(http.StatusOK, GitHubDevicePollResponse{
			Status:    "success",
			Login:     user.Login,
			Name:      user.Name,
			AvatarURL: user.AvatarURL,
			Email:     user.Email,
		})
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

// validateGitHubToken validates a GitHub token and returns user info
func validateGitHubToken(token string) (*GitHubUser, error) {
	req, err := http.NewRequest("GET", "https://api.github.com/user", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to contact GitHub: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode == 401 {
		return nil, fmt.Errorf("invalid or expired token")
	}

	if resp.StatusCode != 200 {
		var errResp struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(body, &errResp); err == nil && errResp.Message != "" {
			return nil, fmt.Errorf("GitHub API error: %s", errResp.Message)
		}
		return nil, fmt.Errorf("GitHub API error: status %d", resp.StatusCode)
	}

	var user GitHubUser
	if err := json.Unmarshal(body, &user); err != nil {
		return nil, fmt.Errorf("failed to parse user info: %w", err)
	}

	return &user, nil
}

// GetGitHubToken retrieves the GitHub token from session or environment
func GetGitHubToken(sessionManager *SessionManager) string {
	// First check session
	if sessionManager != nil {
		session, ok := sessionManager.GetSession()
		if ok && session != nil {
			if token, exists := session.Env["GITHUB_TOKEN"]; exists && token != "" {
				return token
			}
		}
	}

	// Fall back to environment
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		token = os.Getenv("GH_TOKEN")
	}
	return token
}

// GitHubAPIRequest makes an authenticated request to the GitHub API
func GitHubAPIRequest(method, endpoint string, token string, body interface{}) (*http.Response, error) {
	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewReader(jsonBody)
	}

	req, err := http.NewRequest(method, "https://api.github.com"+endpoint, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	client := &http.Client{Timeout: 30 * time.Second}
	return client.Do(req)
}
